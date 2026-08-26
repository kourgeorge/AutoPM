/**
 * L4 — execution, and the guard that sits between the decision maker and the venue.
 *
 * The checks are the FIRST statements of these two functions, not of the tools that call
 * them. That placement is the whole point: the tool layer used to hold them inline, so a
 * second caller — a future scheduler, a recovery path, a script — would have reached the
 * broker with none of them applied. Below the decision maker means below every caller.
 */

import { broker } from '../broker';
import { logger } from '../core/logger';
import { sameSymbol } from '../core/symbols';
import { getState } from '../state/state';
import { SignalResult } from '../core/types';
import { getPolicy } from '../policy/load';
import { getRegime, getCachedRegime } from '../macro/regime';
import type { Regime } from '../macro/regime';
import {
  hasEnoughBuyingPower,
  isAtMaxPositions,
  isDailyLossBreached,
} from './riskManager';
import { requestApproval } from '../core/approvals';

/**
 * A refusal by this system's own rules, as opposed to the venue's (`BrokerRejection`).
 *
 * `rule` is a stable machine name, not prose: it is what lands in the journal's
 * `vetoRule`, and `grep '"vetoRule":"missing_stop"'` has to be able to answer "how often
 * did the model try to open an unstopped position" months later.
 */
export class GuardRejection extends Error {
  constructor(readonly rule: string, message: string) {
    super(message);
    this.name = 'GuardRejection';
  }
}

function reject(rule: string, message: string): never {
  throw new GuardRejection(rule, message);
}

/**
 * `qty` in the result is the qty that reached the venue, which is not necessarily the qty
 * that was asked for: `applyRegimeSizing` may cut it. The caller journals what it is
 * given, so returning the requested number here would record a position size that never
 * existed.
 */
export async function enterPosition(
  signal: SignalResult,
  qty: number,
): Promise<{ orderId: string; qty: number }> {
  const { symbol, price, stopLoss, takeProfit, atr } = signal;

  // Local and free, so first: a NaN qty must be reported as a malformed intent, not as
  // insufficient buying power for `NaN × NaN`.
  if (!Number.isFinite(qty) || qty <= 0) {
    reject('invalid_intent', `qty must be a positive number, got ${qty}`);
  }
  if (![price, stopLoss, takeProfit, atr].every(Number.isFinite)) {
    reject('invalid_intent', `price/stopLoss/takeProfit/atr must all be finite numbers, got ${price}/${stopLoss}/${takeProfit}/${atr}`);
  }
  if (takeProfit <= price) {
    reject('invalid_intent', `takeProfit $${takeProfit} must be above entry $${price}`);
  }

  // `policy.immutable.requireStopOnEntry` has been true since the policy file existed and
  // was enforced nowhere: a `stopLoss: 0` opened a position with no exit level, and every
  // stop detector measures against a level that was never recorded.
  if (!(stopLoss > 0 && stopLoss < price)) {
    reject('missing_stop', `stopLoss $${stopLoss} must be above zero and below entry $${price}`);
  }

  const [account, positions] = await Promise.all([
    broker.getAccountInfo(),
    broker.getPositions(),
  ]);

  if (isDailyLossBreached(account, getState().startOfDayEquity || account.equity)) {
    reject('daily_loss_breached', 'Daily loss limit breached — entry blocked for the rest of the day');
  }
  if (isAtMaxPositions(positions)) {
    reject('max_positions', 'At max positions — exit something before entering');
  }
  // Adding to a winner is a different decision with a different stop; it is not this
  // function's job. Blocking it also protects the entry baselines from being re-derived.
  //
  // `sameSymbol`, not `===`: an order placed as `BTC/USD` comes back from Alpaca as
  // `BTCUSD`, so `===` let the same asset through this guard twice under two spellings.
  if (positions.some((p) => sameSymbol(p.symbol, symbol))) {
    reject('already_holding', `Already holding ${symbol} — exit first, or size the original entry correctly`);
  }

  // Checked against the REQUESTED qty, before `applyRegimeSizing`. Sound only because that
  // function can now only reduce — while it could clamp a fractional qty UP to a whole unit,
  // the order that reached the venue was one this check had never seen.
  if (!hasEnoughBuyingPower(account, signal, qty)) {
    reject('insufficient_buying_power', `Insufficient buying power for ${qty} × $${price} (have $${account.buyingPower.toFixed(2)})`);
  }

  // Regime enforcement: cap qty by regime sizeMult (Ang et al. 2026 pattern).
  // The trader LLM calculates qty at full size; the guard applies the regime multiplier
  // so late_cycle/recession positions are automatically smaller.
  const regimeQty = await applyRegimeSizing(qty);

  // LAST, and after regime sizing: the operator approves the qty that will actually reach
  // the venue, and is never woken for an order the guards above would have refused anyway.
  // Disarmed by policy — the common case — this returns `not_required` without touching the
  // UI, so the ordering above is unchanged for a paper account.
  const nod = await requestApproval('entry', {
    symbol,
    qty: regimeQty,
    price,
    notional: regimeQty * price,
    stopLoss,
    takeProfit,
    pnl: null,
    reason: signal.reason,
  });
  if (!nod.granted) reject(nod.rule, nod.message);

  logger.trade(`Entering ${symbol}: qty=${regimeQty} @ ~$${price.toFixed(2)}, SL=$${stopLoss.toFixed(2)}, TP=$${takeProfit.toFixed(2)}`);
  const { id } = await broker.placeOrder({ symbol, side: 'buy', qty: regimeQty, type: 'market' });
  logger.trade(`Order ${id} submitted for ${symbol}`);
  return { orderId: id, qty: regimeQty };
}

/**
 * Apply regime-based position sizing. Reduces qty in late_cycle/recession.
 *
 * The one invariant: NOTHING LEAVES HERE LARGER THAN WHAT CAME IN. It used to, in both
 * directions at once — `Math.floor` collapsed any fractional request to 0 and a trailing
 * `Math.max(adjusted, 1)` clamped that 0 up to a whole unit, so a request for 0.05 BTC
 * reached the venue as 1 BTC. It fired in `expansion` too, where `mult` is 1 and this
 * function is meant to be a no-op, and it escaped `hasEnoughBuyingPower`, which had already
 * run against the 0.05.
 *
 * Fails open (returns the original qty if the regime is unavailable).
 */
async function applyRegimeSizing(qty: number): Promise<number> {
  try {
    // THE ORDER PATH NEVER WAITS ON THE NETWORK. A cold `getRegime()` can spend ~15s when
    // FRED is slow — one attempt plus a retry, six series in parallel — and every second of
    // it is drift on a market order that has already cleared every guard. Measured
    // 2026-08-26: 15.5s on a timeout storm. The scheduler already refreshes the regime once
    // a cycle off this path, so the cached label is at most one cycle old, and a stale
    // multiplier costs a fraction of a position while a late fill costs the entry price.
    // Only a genuine cold start, with nothing cached at all, pays for a fetch — there is no
    // alternative there, and it happens once.
    const regime = getCachedRegime() ?? (await getRegime());
    const policy = getPolicy();
    const override = policy.regime[regime.regime];
    const mult = Math.min(override.sizeMult, 1.0); // never increase

    // Whole-share requests stay whole; a fractional one stays fractional. Rounding a
    // fraction is not "sizing down", it is changing the asset's unit.
    const scaled = Number.isInteger(qty) ? Math.floor(qty * mult) : qty * mult;

    // A single share halved floors to zero, and a zero-share order is a failed order rather
    // than a smaller one. Fall back to the REQUEST — never to a constant, which is what
    // turned this clamp into an increase.
    const adjusted = scaled > 0 ? Math.min(scaled, qty) : qty;

    if (adjusted < qty) {
      logger.info(`[Guard] Regime ${regime.regime} — size reduced from ${qty} to ${adjusted} (×${mult})`);
    }
    return adjusted;
  } catch {
    // Fail open: if regime fetch fails, use original qty
    return qty;
  }
}

export async function exitPosition(
  symbol: string,
  reason: string,
): Promise<{ orderId: string }> {
  const positions = await broker.getPositions();
  // `sameSymbol`, for the same reason as `already_holding` above — with `===` a crypto
  // position could not be exited AT ALL: the venue reports `BTCUSD`, the caller says
  // `BTC/USD`, and `no_position` threw on a position that was plainly open.
  const pos = positions.find((p) => sameSymbol(p.symbol, symbol));

  // Throws where it used to log a warning and return. The warning let `toolExecuteExit`
  // report `{ ok: true }` for a sell that never happened, and discard the position's
  // baselines on the way out.
  if (!pos) {
    reject('no_position', `No open position in ${symbol} — nothing to exit`);
  }

  // Below the `no_position` guard, so a phantom exit never wakes anyone. The operator sees
  // the venue's own qty and unrealized P&L — the numbers that make the decision — not the
  // model's account of them.
  const nod = await requestApproval('exit', {
    symbol,
    qty: pos.qty,
    price: pos.marketValue != null && pos.qty !== 0 ? pos.marketValue / pos.qty : null,
    notional: pos.marketValue ?? null,
    stopLoss: null,
    takeProfit: null,
    pnl: pos.unrealizedPnL ?? null,
    reason,
  });
  if (!nod.granted) reject(nod.rule, nod.message);

  logger.trade(`Exiting ${symbol}: ${reason}`);
  const { id } = await broker.placeOrder({ symbol, side: 'sell', qty: pos.qty, type: 'market' });
  logger.trade(`Exit order ${id} submitted for ${symbol}`);
  return { orderId: id };
}
