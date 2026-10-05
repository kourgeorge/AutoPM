import { assertExecutionOwner } from '../core/runtime';
/**
 * L4 — execution, and the guard that sits between the decision maker and the venue.
 *
 * The checks are the FIRST statements of these two functions, not of the tools that call
 * them. That placement is the whole point: the tool layer used to hold them inline, so a
 * second caller — a future scheduler, a recovery path, a script — would have reached the
 * broker with none of them applied. Below the decision maker means below every caller.
 */

import { broker } from '../broker';
import { collectPrices } from '../collect/priceSource';
import { canonicalSymbol } from '../core/symbols';
import type { OpenOrder, Position } from '../broker/IBroker';
import { collectBars, DEFAULT_COLLECT_REQUEST, isPresent, type Maybe } from '../collect';
import { getFundamentals, type Fundamentals } from '../collect/fundamentals';
import { logger } from '../core/logger';
import { isCryptoSymbol, sameSymbol } from '../core/symbols';
import { getPositionSnapshot, getState, updateState, patchPositionSnapshot } from '../state/state';
import { withStopLock } from './stopOrders';
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
import { automationLevel } from '../core/automation';
import { createProposal } from '../core/proposals';
import { config } from '../core/config';
import { hasRiskProfile } from '../policy/riskProfiles';
import { assessEntryRisk, entryLimitPrice, type RiskAssessment } from './riskBudget';
import { collectRiskInputs } from './riskData';

/**
 * A refusal by this system's own rules, as opposed to the venue's (`BrokerRejection`).
 *
 * `rule` is a stable machine name, not prose: it is what lands in the journal's
 * `vetoRule`, and `grep '"vetoRule":"missing_stop"'` has to be able to answer "how often
 * did the model try to open an unstopped position" months later.
 */
export class GuardRejection extends Error {
  constructor(
    readonly rule: string,
    message: string,
    /** The venue's own words, when this guard rejection was caused by a broker refusal rather
     * than a policy decision — e.g. `resting_order_not_cancelled`. Null for the rest. */
    readonly venueMessage: string | null = null,
  ) {
    super(message);
    this.name = 'GuardRejection';
  }
}

function reject(rule: string, message: string, venueMessage: string | null = null): never {
  throw new GuardRejection(rule, message, venueMessage);
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
 * because PLAYBOOK.md's chasing rule ends with "or say in the rationale what makes this the
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
 * Small on purpose: a genuine sizing error is an order of magnitude out, not 2%. And it is slack for
 * drift, never a licence — which is why the refusal message below names the clean qty and not this
 * one. A model told it may size 2% over policy would.
 */
const POSITION_SIZE_TOLERANCE = 0.02;

/**
 * Why this entry is too big for one position, or null when it fits.
 *
 * `positionSizePct` is the one risk number that never made it below the decision maker. PLAYBOOK.md
 * told the model to compute `floor(equity x positionSizePct / price)` itself and
 * `positionSizePctCeiling` sat in the `immutable` block, but nothing on the order path read either —
 * so an arbitrarily large single position was a valid intent, and the ceiling was guarding a number
 * in a YAML file rather than an order at the venue. With `maxPositions x positionSizePct` = 100% of
 * equity by default, one decimal slip is the whole book in one name.
 *
 * ONE MEANING FOR THE KNOB: a notional cap, and nothing else. `volatilityScaledQty` used to read it
 * as a risk-at-stop budget as well and hand the model a second answer; it returned the flat notional
 * number in every case that could reach it, so the second answer was the first one wearing a label.
 *
 * Pure and exported for the same reason `entrySignalVeto` is: the live path has already fetched an
 * account by the time this runs, and the scenario's absurd equity baseline would refuse every intent
 * as `daily_loss_breached` two guards earlier. The judgement is the part worth pinning.
 *
 * Returns the message rather than a `{rule, message}` pair — there is only one rule here, and the
 * call site already names it.
 */
export function positionSizeVeto(
  qty: number,
  price: number,
  equity: number,
  policy: Policy,
): string | null {
  const budget = equity * policy.risk.positionSizePct;
  const notional = qty * price;
  if (notional <= budget * (1 + POSITION_SIZE_TOLERANCE)) return null;

  return `${qty} x $${price} = $${notional.toFixed(2)} exceeds the $${budget.toFixed(2)} budget for one `
    + `position (${(policy.risk.positionSizePct * 100).toFixed(1)}% of $${equity.toFixed(2)} equity). `
    + `Size it at ${Math.floor(budget / price)} or fewer.`;
}

/**
 * Why this entry would push the WHOLE BOOK over its gross exposure ceiling, or null when it fits.
 *
 * `positionSizeVeto` above checks one position in isolation; nothing checked the book as a
 * whole. `maxPositions x positionSizePct` is 100% of equity by default, so a string of
 * independently-reasonable entries could still walk the account to a fully (or, on margin,
 * over-) deployed book with no guard noticing, because nothing summed them.
 *
 * Pure and exported for the same reason `positionSizeVeto` is: the judgement — sum the book,
 * add the new notional, compare to the ceiling — needs no network call once positions and
 * equity are in hand.
 *
 * `marketValue` is optional on `Position` (see IBroker); a position missing it is excluded from
 * the sum rather than guessed from entry price, so this guard can only under-count the existing
 * book, never over-refuse on a fabricated number.
 */
export function exposureVeto(
  newNotional: number,
  positions: Position[],
  equity: number,
  policy: Policy,
): string | null {
  const existingGross = positions.reduce(
    (sum, p) => sum + (Number.isFinite(p.marketValue as number) ? Math.abs(p.marketValue as number) : 0),
    0,
  );
  const projectedGross = existingGross + newNotional;
  const ceiling = equity * policy.risk.maxGrossExposurePct;
  if (projectedGross <= ceiling) return null;

  return `Adding $${newNotional.toFixed(2)} would deploy $${projectedGross.toFixed(2)} of the book `
    + `(existing $${existingGross.toFixed(2)} + this entry) against a $${ceiling.toFixed(2)} gross `
    + `exposure ceiling (${(policy.risk.maxGrossExposurePct * 100).toFixed(1)}% of $${equity.toFixed(2)} `
    + `equity). Reduce this entry's size or exit something first.`;
}

/**
 * Why this entry falls inside the earnings blackout, or null when it's clear.
 *
 * Two rules, same split as `SignalVeto` above and for the same reason: `earnings_window`
 * answers "is a print imminent" and `earnings_unavailable` answers "could we tell" — filed
 * under one name, the journal could no longer distinguish an operator who keeps entering
 * into prints from a fortnight of Yahoo trouble.
 *
 * FAILS CLOSED on missing data, matching `signals_unavailable` and `daily_loss_unmeasurable`:
 * an earnings gap jumps straight past a resting stop, so "cannot tell" is not a case this
 * guard can wave through — no evidence, no position.
 *
 * Confirmed and estimated dates are treated identically. PLAYBOOK.md already says why: "the
 * uncertainty is about the day, not about the risk" — an estimate sliding a few days either
 * side is still the same print, and a guard that only blocked confirmed dates would flap open
 * the moment Yahoo's estimate firmed up.
 *
 * Pure and exported for the same reason `entrySignalVeto` is: the judgement — is the next
 * print inside the window — needs no network call once the calendar is in hand.
 */
export type EarningsVeto = {
  rule: 'earnings_window' | 'earnings_unavailable';
  message: string;
};

export function earningsVeto(
  symbol: string,
  calendar: Fundamentals | null,
  blackoutDays: number,
): EarningsVeto | null {
  // Crypto trades 24/7 against no scheduled print — there is no gap for this guard to catch,
  // and `getFundamentals` throws for a crypto pair by design (fundamentals are equities-only).
  if (isCryptoSymbol(symbol)) return null;

  if (!calendar) {
    return {
      rule: 'earnings_unavailable',
      message: `Cannot read ${symbol}'s earnings calendar, so the ${blackoutDays}-day blackout cannot `
        + `be checked. No entry is opened without knowing whether a print is imminent — retry once `
        + `get_calendar(${symbol}) succeeds.`,
    };
  }

  const { nextEarningsAt, daysUntil, isEstimate } = calendar.calendar;
  if (nextEarningsAt === null || daysUntil === null) return null;
  if (daysUntil >= blackoutDays) return null;

  const when = isEstimate === true ? `an estimated ${nextEarningsAt.slice(0, 10)}` : nextEarningsAt.slice(0, 10);
  return {
    rule: 'earnings_window',
    message: `${symbol} reports ${when} — ${daysUntil} day(s) away, inside the ${blackoutDays}-day `
      + `earnings blackout. An earnings gap jumps past a resting stop, so this entry is refused.`,
  };
}

/**
 * `earningsVeto` against the live calendar.
 *
 * Skips the fetch entirely for crypto — see the comment on `earningsVeto` — rather than
 * calling `getFundamentals` and turning its designed-in throw into a spurious
 * `earnings_unavailable` on every crypto entry.
 *
 * A fetch failure (network, or Yahoo's schema drifting past what `validateResult: false`
 * absorbs) resolves to `null` calendar, which the pure veto above turns into
 * `earnings_unavailable` — the fetch failing and the fetch succeeding with nothing scheduled
 * are different claims, and only the pure function can tell them apart.
 */
async function refuseIfEarningsWindow(symbol: string): Promise<void> {
  if (isCryptoSymbol(symbol)) return;

  let calendar: Fundamentals | null;
  try {
    calendar = await getFundamentals(symbol);
  } catch {
    calendar = null;
  }

  const veto = earningsVeto(symbol, calendar, getPolicy().risk.earningsBlackoutDays);
  if (veto) reject(veto.rule, veto.message);
}

/** Everything `enterPosition` knows once the guard chain has passed, ready to place the order. */
export interface ValidatedEntry {
  riskAssessment?: RiskAssessment;
  symbol: string;
  price: number;
  stopLoss: number;
  takeProfit: number;
  regimeQty: number;
  atr: number;
  reason: string;
}

export type SubmittedEntry = { status: 'submitted'; orderId: string; qty: number };

export type QueuedAction = { status: import('../state/state').ProposalStatus; proposalId: string; automatic: boolean };

/**
 * The guard chain, unchanged from before the automation split — every `reject()` call below
 * is the same rule, same order, same message, whether the action ends up executed immediately
 * or held as a proposal for a human to decide.
 */
export async function validateEntry(signal: SignalResult, qty: number, approvedMaxQty = qty): Promise<ValidatedEntry> {
  const { symbol, stopLoss, takeProfit, atr } = signal;
  let price = signal.price;
  const validationStarted = Date.now();

  // Local and free, so first: a NaN qty must be reported as a malformed intent, not as
  // insufficient buying power for `NaN × NaN`.
  if (!Number.isFinite(qty) || qty <= 0) {
    reject('invalid_intent', `qty must be a positive number, got ${qty}`);
  }
  if (!Number.isSafeInteger(approvedMaxQty) || approvedMaxQty <= 0) reject('invalid_intent', 'Approved maximum quantity must be a positive whole-share quantity');
  if (![price, stopLoss, takeProfit, atr].every(Number.isFinite)) {
    reject('invalid_intent', `price/stopLoss/takeProfit/atr must all be finite numbers, got ${price}/${stopLoss}/${takeProfit}/${atr}`);
  }
  if (takeProfit <= price) {
    reject('invalid_intent', `takeProfit $${takeProfit} must be above entry $${price}`);
  }

  // A stop is mandatory on every entry — not a policy toggle, because there is no legitimate
  // case where an unattended position should have no exit level. Before this guard existed,
  // `stopLoss: 0` opened a position anyway, and every stop detector measured against a level
  // that was never recorded.
  if (!(stopLoss > 0 && stopLoss < price)) {
    reject('missing_stop', `stopLoss $${stopLoss} must be above zero and below entry $${price}`);
  }

  if ([stopLoss, takeProfit].some(level => Math.abs(level * 100 - Math.round(level * 100)) > 1e-8)) reject('price_precision', 'Stop and target prices must use whole cents');
  if (getState().paused) reject('paused', 'Trading is paused');
  if (!getState().accountId) reject('account_unbound', 'Verify the brokerage account before trading');
  if (!getPolicy().strategy.watchlist.some(s => canonicalSymbol(s) === canonicalSymbol(symbol))) reject('outside_mandate', 'Symbol is outside the approved trading universe');
  if (isCryptoSymbol(symbol) || !Number.isInteger(qty)) reject('unsupported_asset', 'This worker supports long-only whole-share equities with broker protection');
  if (!(await broker.isMarketOpen())) reject('market_closed', 'Entries wait for the regular market session');
  if (getState().dailyLossHalted) reject('daily_loss_breached', 'Entries are halted for this trading day');
  const quotes = await collectPrices([symbol], getPolicy().triggers.maxQuoteAgeMs);
  const quote = quotes.get(symbol);
  if (!quote || !isPresent(quote) || quote.stale) reject('quote_unavailable', 'A fresh price is required before entry');
  if (Math.abs(quote.value / price - 1) > 0.01) reject('price_changed', 'Price moved more than 1%; request a fresh proposal');
  // A limit order uses this ceiling, so the sizing checks bound actual entry notional.
  price = entryLimitPrice(price, quote.value);
  if (stopLoss >= quote.value || takeProfit <= price) reject('invalid_levels', 'Stop/target must bracket the current price');
  if (!(atr > 0) || quote.value - stopLoss > atr * getPolicy().immutable.stopLossAtrMultCeiling) reject('stop_too_wide', 'Stop exceeds the platform ATR distance ceiling');
  const brokerOrders = await broker.getOpenOrders();
  const openBuys = brokerOrders.filter(order => order.side === 'buy');
  if (openBuys.length) reject('pending_entry', 'An entry is already outstanding; reconcile it before adding exposure');

  const [account, positions] = await Promise.all([
    broker.getAccountInfo(),
    broker.getPositions(),
  ]);

  const unprotected = positions.filter(pos => {
    const snap = getPositionSnapshot(pos.symbol);
    return snap && !brokerOrders.some(order => order.id === snap.stopOrderId && sameSymbol(order.symbol, pos.symbol) && order.side === 'sell' && order.type === 'stop' && order.qty - order.filled >= pos.qty);
  });
  if (unprotected.length) reject('unprotected_holding', 'Confirm broker protection for managed holdings before adding exposure');

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
    updateState({ dailyLossHalted: true });
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
  if (!hasEnoughBuyingPower(account, { ...signal, price }, qty)) {
    reject('insufficient_buying_power', `Insufficient buying power for ${qty} × $${price} (have $${account.buyingPower.toFixed(2)})`);
  }

  // Against the REQUESTED qty, for the same reason as the buying-power check above: regime sizing
  // can only reduce, so a request inside the budget is still inside it after the cut.
  //
  // AFTER buying power, not before, and the order is load-bearing. Buying power is at least equity
  // on any margin account and equity is ten times this budget by default, so anything that fails
  // buying power fails this too — checking size first would make `insufficient_buying_power`
  // unreachable on the entry path and quietly retire a rule PLAYBOOK.md still documents. In this order
  // each keeps the cases it describes best: the venue's arithmetic for what cannot be afforded, and
  // this for what can be afforded and still should not be bought.
  //
  // REFUSES, never trims. `applyRegimeSizing` clamps silently because that is the system's own
  // decision to size down; an oversized request is a wrong intent, and quietly filling it at 10%
  // would journal "taking a 30% position because..." against a position that was never 30%.
  const oversized = positionSizeVeto(qty, price, account.equity, getPolicy());
  if (oversized) reject('position_too_large', oversized);

  // The book-level version of the check above: one correctly-sized position can still be the
  // straw that puts the whole account over its gross exposure ceiling.
  const overExposed = exposureVeto(qty * price, positions, account.equity, getPolicy());
  if (overExposed) reject('exposure_too_high', overExposed);

  // BEFORE the signal gate: a refusal that was going to happen anyway does not deserve a bar
  // fetch, and an imminent print refuses regardless of how strong the setup looks. PLAYBOOK.md
  // stated this window as prose for as long as it existed and nothing enforced it — the same
  // gap this repo's other unenforced-rule fixes have closed, except here the risk a stop-loss
  // cannot bound is the one a gap jumps straight past.
  await refuseIfEarningsWindow(symbol);

  // The entry gate, and the first check here that needs the network. Placed AFTER the broker
  // guards on purpose: `already_holding` and `max_positions` are structural refusals the model
  // can act on ("exit something first"), so when both apply, reporting the structural one is more
  // useful than reporting a weak composite — and a refusal that was going to happen anyway does
  // not deserve a bar fetch.
  //
  // PLAYBOOK.md stated this threshold as prose for as long as it existed and nothing enforced it,
  // while the entry_signal detector armed on an EMA cross that made no reference to it. The two
  // layers genuinely disagreed about what "entry-worthy" meant; this is the side that refuses.
  await refuseUnlessSignalsSupport(symbol);

  // Regime enforcement: cap qty by regime sizeMult (Ang et al. 2026 pattern).
  // The trader LLM calculates qty at full size; the guard applies the regime multiplier
  // so late_cycle/recession positions are automatically smaller.
  const regimeQty = Math.min(await applyRegimeSizing(qty), approvedMaxQty);
  let riskAssessment: RiskAssessment | undefined;
  const policy = getPolicy();
  if (hasRiskProfile(policy.risk)) {
    const inputs = await collectRiskInputs([...positions.map(p => p.symbol), symbol], policy);
    riskAssessment = assessEntryRisk({ symbol, price, stopLoss, takeProfit, qty: regimeQty,
      equity: account.equity, buyingPower: account.buyingPower, positions, policy, inputs });
    if (!riskAssessment.allowed) {
      const violation = riskAssessment.violations[0];
      reject(violation.rule, violation.message);
    }
  }
  if (Date.now() - validationStarted > getPolicy().triggers.maxQuoteAgeMs) reject('quote_expired', 'Price validation expired while checking the trade; request a fresh action');

  return { symbol, price, stopLoss, takeProfit, regimeQty, atr, reason: signal.reason, riskAssessment };
}

/** Called only by the durable executor after its claim has committed. */
export async function actEntry(v: ValidatedEntry, clientOrderId?: string): Promise<SubmittedEntry> {
  const { id } = await guardedBroker().placeOrder({ symbol: v.symbol, side: 'buy', qty: v.regimeQty,
    type: 'limit', limitPrice: v.price, timeInForce: 'ioc', clientOrderId });
  return { status: 'submitted', orderId: id, qty: v.regimeQty };
}

export async function enterPosition(signal: SignalResult, qty: number, eventId?: string): Promise<QueuedAction> {
  const validated = await validateEntry(signal, qty);
  const automatic = automationLevel('entry') === 'auto';
  const proposal = createProposal({ kind: 'entry', symbol: validated.symbol, venue: config.venue,
    automatic, params: { signal, qty, maxQty: validated.regimeQty, price: signal.price,
      stopLoss: signal.stopLoss, takeProfit: signal.takeProfit, riskAssessment: validated.riskAssessment }, reason: signal.reason, eventId,
    timeoutMs: getPolicy().automation.timeoutMs });
  return { status: proposal.status, proposalId: proposal.id, automatic: proposal.automatic ?? false };
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

/** Everything `exitPosition` knows once the position lookup and qty check have passed. */
export interface ValidatedExit {
  pos: Position;
  sellQty: number;
  price: number | null;
  pnl: number | null;
}

export type ExitedPosition = { status: 'submitted'; orderId: string; cancelled: string[]; qty: number };


export async function validateExit(symbol: string, qty?: number): Promise<ValidatedExit> {
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

  // Omitted `qty` keeps the full-exit behaviour verbatim, including fractional crypto qty.
  // A supplied `qty` is a partial exit and must be a whole share count within the position —
  // `enterPosition` never fractions a share count either, so a partial sell can't either.
  if (qty !== undefined && (!Number.isInteger(qty) || qty <= 0 || qty > pos.qty)) {
    reject(
      'invalid_intent',
      `qty must be a positive integer no greater than the ${pos.qty} held, got ${qty}`,
    );
  }
  if (getState().paused) reject('paused', 'Trading is paused');
  if (!getState().accountId) reject('account_unbound', 'Verify the brokerage account before trading');
  if (!getPositionSnapshot(symbol)) reject('unmanaged_position', 'Adopt this position explicitly before the bot manages it');
  if (pos.qty <= 0) reject('unsupported_position', 'Short positions cannot be managed by this worker');
  if (!(await broker.isMarketOpen())) reject('market_closed', 'Exit deferred until the market opens; existing protection remains');
  const sellQty = qty ?? pos.qty;

  // Below the `no_position` guard, so a phantom exit never wakes anyone. The operator sees
  // the venue's own qty and unrealized P&L — the numbers that make the decision — not the
  // model's account of them.
  const price = pos.marketValue != null && pos.qty !== 0 ? pos.marketValue / pos.qty : null;
  return { pos, sellQty, price, pnl: pos.unrealizedPnL ?? null };
}

/**
 * Cancels the resting protection and sells. Never called until a `validateExit` has passed —
 * and, on the manual path, until a human has approved: cancelling the reservation on an exit
 * that is then denied would leave the position worse off than if the tool had never been
 * called. That ordering is the reason this is a separate function at all.
 */
export async function actExit(symbol: string, reason: string, v: ValidatedExit, clientOrderId?: string): Promise<ExitedPosition> {
  const { pos, sellQty } = v;
  logger.trade(`Exiting ${symbol}: ${reason}`);

  // Under the stop lock for everything that follows. Between the cancel loop and the sell this
  // position is held, has a recorded level, and has no stop resting — which is exactly the shape
  // `needsArming` selects. A sweep landing in that gap would re-arm, re-reserve the shares, and
  // the sell below would fail with `insufficient qty available`: the precise error the cancel loop
  // exists to prevent, reintroduced by the thing meant to prevent it.
  return withStopLock(symbol, async () => {
    // Which resting stop/take-profit legs are OURS, read before anything is cancelled. It
    // decides what may be put back if the sell fails — see the restore below.
    const ourStopId = getPositionSnapshot(symbol)?.stopOrderId;
    const ourTpId = getPositionSnapshot(symbol)?.takeProfitOrderId;

    // Clear the reservation before selling, and only AFTER approval — cancelling the
    // protection on an exit the operator then denies would leave the position worse off than
    // if the tool had never been called.
    const cancelled: string[] = [];
    let cancelledOurStop = false;
    let cancelledOurTp = false;
    const sells = restingSells(await broker.getOpenOrders(), symbol);
    if (sells.some(order => order.id !== ourStopId && order.id !== ourTpId)) {
      reject('external_order', 'Another order reserves this position; the bot will not cancel orders it does not own');
    }
    for (const order of sells) {
      try {
        await guardedBroker().cancelOrder(order.id);
      } catch (err: any) {
        // Refuse the exit rather than sell into a reservation that is still standing. Nothing
        // has changed at this point — the order still rests, the position is still protected —
        // so aborting is the cheap outcome and the venue's own words are the reason.
        //
        // Strict on purpose. An order that had already filled or been cancelled would not have
        // come back from `getOpenOrders`, so the only way here is a genuine venue failure or
        // the narrow race between the list and the cancel; the retry after that race succeeds
        // because the order is no longer listed.
        const venueMessage = err?.response?.data?.message ?? err?.message ?? String(err);
        reject(
          'resting_order_not_cancelled',
          `Cannot exit ${symbol}: ${describe(order)} reserves the shares and the venue refused `
          + `to cancel it — ${venueMessage}`,
          venueMessage,
        );
      }
      if (order.id === ourStopId) cancelledOurStop = true;
      if (order.id === ourTpId) cancelledOurTp = true;
      cancelled.push(describe(order));
      logger.trade(`Cancelled ${describe(order)} — it reserved the ${symbol} shares`);
    }

    // Recorded the moment it is true. The order is gone from the venue, so an id still sitting in
    // state would read as protection that is not there.
    if (cancelledOurStop) patchPositionSnapshot(symbol, { stopOrderId: undefined });
    if (cancelledOurTp) patchPositionSnapshot(symbol, { takeProfitOrderId: undefined });

    let id: string;
    try {
      const heldNow = (await broker.getPositions()).find(p => sameSymbol(p.symbol, symbol));
      if (!heldNow || heldNow.qty < sellQty) reject('position_changed', 'Position changed during cancellation; no sell submitted');
      if (getState().paused) reject('paused_before_submission', 'Trading paused during cancellation; no sell was submitted');
      ({ id } = await guardedBroker().placeOrder({ symbol, side: 'sell', qty: sellQty, type: 'market', clientOrderId }));
    } catch (err) {
      // Preserve the action as unknown in the executor. Reconciliation must establish
      // whether a sell exists before the stop sweep can reserve these shares again.
      throw err;
    }

    logger.trade(`Exit order ${id} submitted for ${symbol}`);
    return { status: 'submitted', orderId: id, cancelled, qty: sellQty };
  });
}

/**
 * When the automation level for `exit` is `manual`, this validates and then STOPS — it creates
 * a proposal and returns `pending` immediately, WITHOUT cancelling the resting stop/take-profit
 * pair or touching the venue. A human's `approve <id>` is picked up by `proposalExecutor.ts`'s
 * `sweepProposals()` on a later tick, which re-validates against the position as it stands at
 * that moment and only then calls `actExit` — the point in the code where cancellation happens,
 * unchanged from before this split.
 */
export async function exitPosition(symbol: string, reason: string, qty?: number, eventId?: string): Promise<QueuedAction> {
  const validated = await validateExit(symbol, qty);
  const automatic = automationLevel('exit') === 'auto';
  const proposal = createProposal({ kind: 'exit', symbol, venue: config.venue, reason, eventId, automatic,
    params: { qty: validated.sellQty, price: validated.price, pnl: validated.pnl },
    timeoutMs: getPolicy().automation.timeoutMs });
  return { status: proposal.status, proposalId: proposal.id, automatic: proposal.automatic ?? false };
}

function guardedBroker() { assertExecutionOwner(); return broker; }
