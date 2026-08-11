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
import { getState } from '../state/state';
import { SignalResult } from '../core/types';
import {
  hasEnoughBuyingPower,
  isAtMaxPositions,
  isDailyLossBreached,
} from './riskManager';

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

export async function enterPosition(
  signal: SignalResult,
  qty: number,
): Promise<{ orderId: string }> {
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
  if (positions.some((p) => p.symbol === symbol)) {
    reject('already_holding', `Already holding ${symbol} — exit first, or size the original entry correctly`);
  }
  if (!hasEnoughBuyingPower(account, signal, qty)) {
    reject('insufficient_buying_power', `Insufficient buying power for ${qty} × $${price} (have $${account.buyingPower.toFixed(2)})`);
  }

  logger.trade(`Entering ${symbol}: qty=${qty} @ ~$${price.toFixed(2)}, SL=$${stopLoss.toFixed(2)}, TP=$${takeProfit.toFixed(2)}`);
  const { id } = await broker.placeOrder({ symbol, side: 'buy', qty, type: 'market' });
  logger.trade(`Order ${id} submitted for ${symbol}`);
  return { orderId: id };
}

export async function exitPosition(
  symbol: string,
  reason: string,
): Promise<{ orderId: string }> {
  const positions = await broker.getPositions();
  const pos = positions.find((p) => p.symbol === symbol);

  // Throws where it used to log a warning and return. The warning let `toolExecuteExit`
  // report `{ ok: true }` for a sell that never happened, and discard the position's
  // baselines on the way out.
  if (!pos) {
    reject('no_position', `No open position in ${symbol} — nothing to exit`);
  }

  logger.trade(`Exiting ${symbol}: ${reason}`);
  const { id } = await broker.placeOrder({ symbol, side: 'sell', qty: pos.qty, type: 'market' });
  logger.trade(`Exit order ${id} submitted for ${symbol}`);
  return { orderId: id };
}
