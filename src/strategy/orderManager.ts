/**
 * L4 — execution, and the guard that sits between the decision maker and the venue.
 *
 * The checks are the FIRST statements of these two functions, not of the tools that call
 * them. That placement is the whole point: the tool layer used to hold them inline, so a
 * second caller — a future scheduler, a recovery path, a script — would have reached the
 * broker with none of them applied. Below the decision maker means below every caller.
 */

import { broker } from '../broker';
import type { OpenOrder } from '../broker/IBroker';
import { collectBars, DEFAULT_COLLECT_REQUEST, isPresent, type Maybe } from '../collect';
import { logger } from '../core/logger';
import { sameSymbol } from '../core/symbols';
import { getPositionSnapshot, getState, patchPositionSnapshot } from '../state/state';
import { armStop, withStopLock, type ArmResult } from './stopOrders';
import { computeSignals, signalTally } from './signals';
import { Bar, SignalResult } from '../core/types';
import { getPolicy } from '../policy/load';
import type { Policy } from '../policy/types';
import { getRegime, getCachedRegime } from '../macro/regime';
import type { Regime } from '../macro/regime';
import {
  dailyLossStatus,
  hasEnoughBuyingPower,
  isAtMaxPositions,
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
 * Why an entry was refused on its signals, or null when the setup clears the gate.
 *
 * Two rules, not one, and the split is the point. `low_composite` answers "was the setup strong
 * enough" and `signals_unavailable` answers "could we tell". Filed under one name, the journal
 * could no longer distinguish a season of weak setups from a fortnight of bar-feed trouble, and
 * `grep '"vetoRule":"low_composite"'` is the only way that question gets answered months later.
 */
export type SignalVeto = {
  rule: 'low_composite' | 'signals_unavailable';
  message: string;
};

/**
 * The entry gate: does this symbol's composite clear the threshold?
 *
 * Pure and exported so the replay harness can assert the decision without a venue and without a
 * bar feed — same division as `restingSells` below. The judgement is the part worth pinning; the
 * fetching is the part that needs a network.
 *
 * REFUSES ON MISSING DATA. Unscoreable bars are not a caveat to note and carry on from:
 * `get_signals` already declines to score a stale series rather than scoring it with a warning,
 * and a guard that entered anyway would be the second, laxer opinion on what "scoreable" means.
 * The cost is that a bar outage blocks new entries, which is the correct trade for an unattended
 * agent — no evidence, no position — and it leaves open positions entirely untouched.
 *
 * Reads the composite, never the vote count, and never `reversal`. The composite because a tally
 * cannot tell three signals barely past the dead band from three screaming ones. Not `reversal`
 * because POLICY.md's chasing rule ends with "or say in the rationale what makes this the
 * exception" — a rule with an escape hatch is a judgement, and moving it here would delete the
 * hatch while the prose still promised it.
 */
export function entrySignalVeto(
  symbol: string,
  bars: Maybe<Bar[]>,
  policy: Policy,
  compositeMin: number,
): SignalVeto | null {
  const unavailable = (why: string): SignalVeto => ({
    rule: 'signals_unavailable',
    message: `Cannot score ${symbol}, so the entry gate cannot be applied: ${why}. `
      + `No entry is opened on unmeasured signals — retry when bars are available.`,
  });

  if (!isPresent(bars)) return unavailable(`no bars from ${bars.source}: ${bars.error}`);
  if (bars.stale) return unavailable(`bars are stale as of ${bars.asOf}`);
  if (bars.value.length < policy.strategy.minBars) {
    return unavailable(`insufficient history: ${bars.value.length} bars, need ${policy.strategy.minBars}`);
  }

  const { composite } = signalTally(computeSignals(bars.value, policy));

  // Null and "below the threshold" are different claims, so they get different rules. Reaching
  // here needs `minBars` bars, which `computeSignals` always scores, so this is a guard against a
  // future signal set that can decline rather than a case seen today.
  if (composite === null) return unavailable('the signals produced no composite');

  if (composite < compositeMin) {
    return {
      rule: 'low_composite',
      message: `${symbol} composite ${composite >= 0 ? '+' : ''}${composite.toFixed(2)} is below the `
        + `entry minimum of +${compositeMin.toFixed(2)} — the setup is not strong enough to open. `
        + `Read the five scores with get_signals(${symbol}) before trying again.`,
    };
  }

  return null;
}

/**
 * `entrySignalVeto` against the live feed.
 *
 * The threshold is resolved from the CACHED regime only, exactly as `entrySignalDetector` resolves
 * its RSI floor. Two reasons, and both matter: the detector and the guard must agree about which
 * regime it is, or attention and permission drift apart again; and the order path never waits on
 * the network for a regime (see `applyRegimeSizing` — a cold `getRegime()` has been measured at
 * 15s, which is pure drift on a market order that has already cleared every other guard).
 */
async function refuseUnlessSignalsSupport(symbol: string): Promise<void> {
  const policy = getPolicy();
  const regime = getCachedRegime();
  const compositeMin = regime
    ? policy.regime[regime.regime].compositeMin
    : policy.strategy.compositeMin;

  // Same request shape as `get_signals` and as the tick, so a guard, a tool and an event can
  // never report different scores for one symbol at one moment.
  const bars = await collectBars(
    symbol,
    DEFAULT_COLLECT_REQUEST.barLimit,
    DEFAULT_COLLECT_REQUEST.timeframe,
  );

  const veto = entrySignalVeto(symbol, bars, policy, compositeMin);
  if (veto) reject(veto.rule, veto.message);
}

/**
 * How far over the position-size budget a request may land before it is refused.
 *
 * This covers EQUITY drift, not price drift. `price` in an entry is the number the model passed, so
 * its own arithmetic divided by the same one; `equity` is read fresh from the venue inside the guard,
 * minutes after the `get_account` the model sized against, and a deployed book moves in between.
 * Without the allowance a correctly-sized entry gets refused for a rounding artefact.
 *
 * Small on purpose: a genuine sizing error is an order of magnitude out, not 2%.
 */
const POSITION_SIZE_TOLERANCE = 0.02;

/**
 * `qty` in the result is the qty that reached the venue, which is not necessarily the qty
 * that was asked for: `applyRegimeSizing` may cut it. The caller journals what it is
 * given, so returning the requested number here would record a position size that never
 * existed.
 *
 * `venueStop` is the outcome of arming a real resting stop at the broker. It is returned rather
 * than written here because the snapshot does not exist yet — `patchPositionSnapshot` is a no-op
 * for an unknown symbol, and the caller's single `openPositionSnapshot` call is the one write.
 * A failure there is reported, never thrown: see `armEntryStop`.
 */
export async function enterPosition(
  signal: SignalResult,
  qty: number,
): Promise<{ orderId: string; qty: number; venueStop: ArmResult }> {
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

  // The baseline is passed RAW. It used to read `getState().startOfDayEquity || account.equity`,
  // which measured today's loss against today's equity whenever the daily reset had not run —
  // exactly 0.00%, so the one guard that halts a losing day could not trip on the day it was
  // most needed. `dailyLossStatus` owns that case now and names it.
  const daily = dailyLossStatus(
    account.equity,
    getState().startOfDayEquity,
    getPolicy().risk.maxDailyLossPct,
  );
  if (daily.state === 'breached') {
    reject(
      'daily_loss_breached',
      `Daily loss ${daily.dayPnLPct!.toFixed(2)}% is past the ${daily.thresholdPct.toFixed(2)}% limit `
        + '— entry blocked for the rest of the day',
    );
  }
  // Fail CLOSED. Nothing here can show this entry is inside the daily limit, and a guard that
  // cannot show it must refuse rather than wave the order through. Filed under its own rule name
  // so the journal can tell a halted day from a blown one: `grep '"vetoRule":"daily_loss_
  // unmeasurable"'` is the only way that question gets answered months later.
  //
  // Entries only — this guard never runs on the exit path, so a position can always be closed.
  if (daily.state === 'unmeasurable') {
    reject(
      'daily_loss_unmeasurable',
      `Cannot measure today's loss — ${daily.reason}. Entries are blocked until the daily reset `
        + 'establishes a baseline; exits are unaffected.',
    );
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

  // The one risk number that never made it below the decision maker. POLICY.md told the model to
  // compute `floor(equity x positionSizePct / price)` itself and `positionSizePctCeiling` sat in the
  // immutable block, but nothing on the order path read either — so an arbitrarily large single
  // position was a valid intent, and the ceiling was guarding a number in a YAML file rather than an
  // order at the venue. With `maxPositions x positionSizePct` = 100% of equity by default, one
  // decimal slip is the whole book in one name.
  //
  // Against the REQUESTED qty, for the same reason as the buying-power check above: regime sizing
  // can only reduce, so a request inside the budget is still inside it after the cut.
  //
  // REFUSES, never trims. `applyRegimeSizing` clamps silently because that is the system's own
  // decision to size down; an oversized request is a wrong intent, and quietly filling it at 10%
  // would journal "taking a 30% position because..." against a position that was never 30%.
  const sizeBudget = account.equity * getPolicy().risk.positionSizePct;
  if (qty * price > sizeBudget * (1 + POSITION_SIZE_TOLERANCE)) {
    reject('position_too_large',
      `${qty} x $${price} = $${(qty * price).toFixed(2)} exceeds the $${sizeBudget.toFixed(2)} budget for `
      + `one position (${(getPolicy().risk.positionSizePct * 100).toFixed(1)}% of $${account.equity.toFixed(2)} `
      + `equity). Size it at ${Math.floor(sizeBudget / price)} or fewer.`);
  }

  // The entry gate, and the first check here that needs the network. Placed AFTER the broker
  // guards on purpose: `already_holding` and `max_positions` are structural refusals the model
  // can act on ("exit something first"), so when both apply, reporting the structural one is more
  // useful than reporting a weak composite — and a refusal that was going to happen anyway does
  // not deserve a bar fetch.
  //
  // POLICY.md stated this threshold as prose for as long as it existed and nothing enforced it,
  // while the entry_signal detector armed on an EMA cross that made no reference to it. The two
  // layers genuinely disagreed about what "entry-worthy" meant; this is the side that refuses.
  await refuseUnlessSignalsSupport(symbol);

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

  const venueStop = await armEntryStop(symbol, stopLoss);
  return { orderId: id, qty: regimeQty, venueStop };
}

/**
 * How long to wait for the buy to become shares that can be protected.
 *
 * The wait is unavoidable. Alpaca reserves against `qty_available`, so a sell stop placed before
 * the buy has settled into the position is refused for shares that are not there yet — the same
 * arithmetic `restingSells` describes, seen from the other side.
 *
 * The bound is just as necessary. A market order submitted pre-market fills at the open, which
 * can be hours away, and this function sits in the middle of a tool call the model is waiting on.
 * Four seconds covers a normal-hours fill on a liquid name with room to spare; anything slower is
 * handed to `sweepStops`, which exists precisely so this deadline can be short.
 */
const FILL_WAIT_MS = 4_000;
const FILL_POLL_MS = 400;

/**
 * Arm the venue stop for a position just opened, and report rather than throw.
 *
 * NEVER FAILS THE ENTRY. The shares are already bought by the time this runs, so throwing would
 * report a failed entry for a position that exists — the worst of the available outcomes, because
 * the caller would not journal it. Everything this can fail at is also repaired by the sweep on
 * the next tick, and the recorded `stopLevel` and its detector are untouched either way.
 *
 * Under the stop lock, and this is not belt-and-braces. A LEFTOVER SNAPSHOT from a previous closed
 * trade in the same symbol is a documented fact of this system, and it carries the OLD stop level.
 * A sweep landing during the poll below sees a held position and that stale level, and would arm
 * at last trade's stop while this arms at today's.
 */
async function armEntryStop(symbol: string, stopLoss: number): Promise<ArmResult> {
  return withStopLock(symbol, async () => {
    const deadline = Date.now() + FILL_WAIT_MS;
    let lastRefusal: string | null = null;

    while (Date.now() < deadline) {
      let held = 0;
      try {
        const positions = await broker.getPositions();
        held = positions.find((p) => sameSymbol(p.symbol, symbol))?.qty ?? 0;
      } catch {
        // A read failure is not a fill failure. Keep polling until the deadline; the sweep is
        // the backstop if the venue is genuinely unreachable.
      }

      // The FILLED qty, not the requested one. A partial fill holds fewer shares than were
      // ordered, and a stop for more than is held is refused in full rather than trimmed.
      if (held > 0) {
        const armed = await armStop(symbol, held, stopLoss);
        if (armed.ok) return armed;
        // KEEP TRYING until the deadline rather than surrendering to the first refusal. The
        // position existing does not mean its shares can be sold yet: Alpaca reserves against
        // `qty_available`, which trails the fill, so the first attempt after a fill can be
        // refused for shares that are visibly held. Giving up there hands a position that could
        // have been protected in another half-second to a sweep up to a minute away. A refusal
        // that is permanent (crypto, a nonsense level) is a pure check that fails instantly, so
        // retrying it costs one comparison per poll and nothing at the venue.
        lastRefusal = armed.reason;
      }

      await new Promise((r) => setTimeout(r, FILL_POLL_MS));
    }

    return {
      ok: false,
      reason: lastRefusal
        ? `the shares were held but the stop was refused for ${FILL_WAIT_MS / 1000}s: ${lastRefusal}`
        : `the buy did not confirm as a position within ${FILL_WAIT_MS / 1000}s, so there were `
          + `no settled shares to place a stop against. The recorded level is being watched by the `
          + `breach detector, and the stop sweep will arm the venue stop on a later tick.`,
    };
  });
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

/**
 * The open orders that would make a sell of this symbol impossible.
 *
 * Alpaca does not count the shares you own, it counts the shares nothing else has a claim
 * on: `qty_available` is the position minus everything reserved by open SELL orders. A
 * resting sell stop for the whole position therefore reserves the whole position, and a
 * market sell alongside it is refused with `403 insufficient qty available (available: 0)`
 * — measured on CRM 2026-08-28, 25 shares held, 25 reserved by a GTC stop at 186.40.
 *
 * Every open sell counts, not only stops. A take-profit limit reserves shares by exactly
 * the same arithmetic, and a partially filled sell reserves its remainder. Buys are
 * irrelevant: they reserve buying power, not shares.
 *
 * Pure and exported so the replay harness can assert the selection without a venue — the
 * decision about what is in the way is the part worth pinning, and the cancelling is the
 * part that needs a broker.
 */
export function restingSells(orders: OpenOrder[], symbol: string): OpenOrder[] {
  // `sameSymbol` for the same reason it is used below: the venue says `BTCUSD` where the
  // caller says `BTC/USD`, and with `===` the blocking order would be invisible.
  return orders.filter((o) => o.side === 'sell' && sameSymbol(o.symbol, symbol));
}

/** One line per cancelled order, for the log and for the model's tool result. */
function describe(o: OpenOrder): string {
  const trigger = o.stopPrice ?? o.limitPrice;
  return `${o.rawType} sell ${o.qty}${o.filled > 0 ? ` (${o.filled} filled)` : ''}`
    + `${trigger !== undefined ? ` @ ${trigger}` : ''} [${o.id}]`;
}

export async function exitPosition(
  symbol: string,
  reason: string,
): Promise<{ orderId: string; cancelled: string[] }> {
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

  // Under the stop lock for everything that follows. Between the cancel loop and the sell this
  // position is held, has a recorded level, and has no stop resting — which is exactly the shape
  // `needsArming` selects. A sweep landing in that gap would re-arm, re-reserve the shares, and
  // the sell below would fail with `insufficient qty available`: the precise error the cancel loop
  // exists to prevent, reintroduced by the thing meant to prevent it.
  return withStopLock(symbol, async () => {
    // Which resting stop is OURS, read before anything is cancelled. It decides what may be put
    // back if the sell fails — see the restore below.
    const ourStopId = getPositionSnapshot(symbol)?.stopOrderId;
    const recordedStop = getPositionSnapshot(symbol)?.stopLevel;

    // Clear the reservation before selling, and only AFTER approval — cancelling the
    // protection on an exit the operator then denies would leave the position worse off than
    // if the tool had never been called.
    const cancelled: string[] = [];
    let cancelledOurStop = false;
    for (const order of restingSells(await broker.getOpenOrders(), symbol)) {
      try {
        await broker.cancelOrder(order.id);
      } catch (err: any) {
        // Refuse the exit rather than sell into a reservation that is still standing. Nothing
        // has changed at this point — the order still rests, the position is still protected —
        // so aborting is the cheap outcome and the venue's own words are the reason.
        //
        // Strict on purpose. An order that had already filled or been cancelled would not have
        // come back from `getOpenOrders`, so the only way here is a genuine venue failure or
        // the narrow race between the list and the cancel; the retry after that race succeeds
        // because the order is no longer listed.
        reject(
          'resting_order_not_cancelled',
          `Cannot exit ${symbol}: ${describe(order)} reserves the shares and the venue refused `
          + `to cancel it — ${err?.response?.data?.message ?? err?.message ?? String(err)}`,
        );
      }
      if (order.id === ourStopId) cancelledOurStop = true;
      cancelled.push(describe(order));
      logger.trade(`Cancelled ${describe(order)} — it reserved the ${symbol} shares`);
    }

    // Recorded the moment it is true. The order is gone from the venue, so an id still sitting in
    // state would read as protection that is not there.
    if (cancelledOurStop) patchPositionSnapshot(symbol, { stopOrderId: undefined });

    // CAVEAT, IBKR ONLY: `IBKRBroker.cancelOrder` does not await anything — TWS takes the
    // request and confirms asynchronously, so the loop above reports success it has not seen.
    // A sell placed immediately after can still race the cancellation. Alpaca's is a DELETE
    // that either returns or throws, so there the cancellation is settled before the sell.
    let id: string;
    try {
      ({ id } = await broker.placeOrder({ symbol, side: 'sell', qty: pos.qty, type: 'market' }));
    } catch (err) {
      // The regression this feature creates, and its repair. Before venue stops the cancel loop
      // could only ever remove protection this system had not placed, so a failed sell left the
      // position exactly as protected as it had ever been. Now the loop takes down OUR stop
      // first, and a failed sell would leave the position naked with nobody having decided that.
      //
      // Only ours goes back. A hand-placed order cancelled alongside it is not this system's to
      // recreate — its qty, type and intent were somebody else's decision — and `cancelled[]`
      // already tells the operator it is gone.
      if (cancelledOurStop && recordedStop != null && recordedStop > 0) {
        const restored = await armStop(symbol, pos.qty, recordedStop);
        if (restored.ok) {
          patchPositionSnapshot(symbol, { stopOrderId: restored.orderId });
          logger.warn(
            `[Guard] ${symbol} sell failed — its stop was put back at $${recordedStop} `
              + `(order ${restored.orderId})`,
          );
        } else {
          logger.error(
            `[Guard] ${symbol} sell failed AND its stop could not be put back — the position is `
              + `unprotected at the venue: ${restored.reason}`,
          );
        }
      }
      throw err;
    }

    logger.trade(`Exit order ${id} submitted for ${symbol}`);
    return { orderId: id, cancelled };
  });
}
