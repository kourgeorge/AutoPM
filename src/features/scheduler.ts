/**
 * L2 — the scheduler. The loop that inverts control.
 *
 * Deterministic code runs perpetually; the LLM is woken only when something crosses.
 * One tick is: reset the day if the date turned -> collect + derive (L1/L2) -> evaluate
 * every detector -> publish. What happens to the published events is the ROUTER's
 * business, and the router is injected, so this file has no opinion about waking anyone.
 *
 * Two properties matter more than anything else here:
 *
 *  1. TICKS DO NOT OVERLAP. `setTimeout` is re-armed after the previous tick settles,
 *     never `setInterval`. A broker call slower than `tickIntervalMs` would otherwise
 *     stack concurrent ticks, each computing features from a different instant and
 *     racing on the same `sessionHigh` write.
 *
 *  2. A TICK NEVER THROWS OUT. A failed collect must produce a logged failure and a
 *     scheduled retry, not a dead loop. Silence is the one failure mode this whole
 *     redesign exists to eliminate.
 */

import { collectAccount } from '../collect';
import { isPresent, isUsable } from '../collect/types';
import { logger } from '../core/logger';
import { etDate, etNow, type MarketSession } from '../core/time';
import { getPolicy } from '../policy/load';
import type { Policy } from '../policy/types';
import { getState, resetDailyState, updateState } from '../state/state';
import { reconcileFills } from '../review/reconcile';
import { publishReviewReady } from '../review/reviewReady';
import { collectAndCompute } from './compute';
import { DETECTORS } from './detectors';
import { publishTick, type Detector, type TriggerEvent } from './eventBus';

/**
 * How often to copy the broker's recent fills into the durable ledger.
 *
 * Slow relative to `tickIntervalMs` because nothing acts on the result within a session:
 * the ledger feeds review, not trading. Not in policy.yaml, which holds numbers an operator
 * tunes to change how the system TRADES — this changes only how often it writes things down.
 */
const RECONCILE_INTERVAL_MS = 5 * 60_000;

/** What to do with a tick's events. Injected so the scheduler can run observe-only. */
export type EventRouter = (events: TriggerEvent[]) => void;

export interface SchedulerOptions {
  route: EventRouter;
  detectors?: Detector[];
  /** Re-read on every tick, so a hot-reloaded policy changes the cadence live. */
  policy?: () => Policy;
}

/**
 * Re-baseline the trading day when the ET date turns.
 *
 * This used to live in `toolGetAccount`, which meant the daily loss limit was only ever
 * re-baselined when the LLM happened to call a tool — so the one number the limit is
 * measured against depended on the model's choices. It also keyed off the UTC date, which
 * rolls over mid-evening ET and re-baselines a day that is still in progress.
 *
 * Failure is deliberately non-fatal and deliberately does NOT advance `lastResetDate`: a
 * stale baseline that retries next tick is recoverable, a wrong one silently mis-measures
 * every daily-loss comparison for the rest of the session.
 */
export async function ensureDailyReset(now: Date = new Date()): Promise<boolean> {
  const today = etDate(now);
  if (getState().lastResetDate === today) return false;

  const account = await collectAccount();
  if (!isUsable(account)) {
    const reason = isPresent(account) ? `stale as of ${account.asOf}` : account.error;
    logger.warn(
      `[Scheduler] Daily reset for ${today} deferred — ${reason}. ` +
        `Baseline still $${getState().startOfDayEquity.toFixed(2)} from ${getState().lastResetDate || 'never'}`,
    );
    return false;
  }

  // Which equity is "start of day" depends on when this reset actually happens.
  //
  // Before the open, current equity IS the start of the day. After it, current equity is
  // mid-day equity, and using it read every late start as a flat day: start at 14:00 after a
  // 3% drawdown and `isDailyLossBreached` compared today's loss against today's loss, i.e.
  // zero, switching the limit off for the rest of the session. The previous close is the
  // honest baseline, so prefer it whenever the venue reports one.
  //
  // ET wall clock, not `marketSession()`, which answers 'closed' both before the open and
  // late in the evening — the two cases that need opposite baselines.
  const et = etNow(now);
  const afterOpen = et.hours * 60 + et.minutes >= 570; // 09:30 ET
  const prevClose = account.value.previousCloseEquity;
  const baseline = afterOpen && prevClose != null ? prevClose : account.value.equity;

  resetDailyState(baseline, today);
  const provenance = !afterOpen
    ? 'current equity, before the open'
    : prevClose != null
      ? 'previous close'
      : `current equity — reset ran at ${et.timeStr} ET and the venue reports no previous close, ` +
        `so today's move before now is not in this baseline`;
  logger.info(`[Scheduler] Daily reset for ${today} — start equity $${baseline.toFixed(2)} (${provenance})`);

  // Release every trigger latch, because the day it was measured against is over.
  //
  // A fired key stays quiet until price RECROSSES its threshold (eventBus gate 1). Correct
  // inside a session — it is what stops one wobble alerting all afternoon — but the recross
  // is a live-price event, so a threshold that un-breached overnight, or while the daemon was
  // down, or before the position was even opened, never happens and the key is muted forever.
  // Measured 2026-08-14: 13 of 35 keys latched, among them `trailing_drawdown:NVDA`,
  // `position_drop:SPCX` and `ema_cross_down:TSLA` — all live positions, all silenced — plus
  // GOOGL and SQ keys for symbols long sold, which would have pre-muted a genuine breach on
  // any re-entry.
  //
  // A day is the right lifetime: drawdown-from-session-high, position drop and data staleness
  // are all day-scoped ideas, so at most one alert per condition per DAY replaces at most one
  // per condition EVER. Arming still persists across a restart within the same day, which is
  // what gate 1 was written for. Wholesale, because a key surviving this is a key nobody can
  // see is stuck; the cost of releasing one that did not need it is a single duplicate alert
  // at the open, and this also caps the unbounded growth of both maps at one day's keys.
  const stale = Object.keys(getState().eventCooldowns).length;
  if (stale > 0) {
    updateState({ eventCooldowns: {}, armedTriggers: [] });
    logger.info(
      `[Scheduler] Released ${stale} trigger latch(es) for the new day — every condition ` +
        `may report once more, measured against today's prices.`,
    );
  }
  return true;
}

export class FeatureScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private ticking = false;
  private readonly detectors: Detector[];
  private readonly route: EventRouter;
  private readonly policyOf: () => Policy;
  private lastReconcileAt = 0;
  private lastSession: MarketSession | null = null;

  constructor(opts: SchedulerOptions) {
    this.route = opts.route;
    this.detectors = opts.detectors ?? DETECTORS;
    this.policyOf = opts.policy ?? getPolicy;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info(
      `[Scheduler] Started — ${this.detectors.length} detectors every ${this.policyOf().triggers.tickIntervalMs}ms`,
    );
    void this.runTick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('[Scheduler] Stopped');
  }

  /**
   * One tick, on demand. Exposed so the daemon's startup path can force a fresh compute
   * without waiting out the interval.
   */
  async tickOnce(): Promise<TriggerEvent[]> {
    const policy = this.policyOf();
    await ensureDailyReset();
    const data = await collectAndCompute(policy);
    const events = publishTick(this.detectors, data, policy);
    if (events.length > 0) this.route(events);
    // After routing, never before: reconciliation feeds review and must not delay a
    // critical event by the length of a broker call. `reconcileFills` swallows its own
    // errors, so this cannot cost the tick either.
    await this.maybeReconcile(data.session);
    return events;
  }

  /**
   * Reconcile on a slow cadence, and unconditionally the moment the session leaves `open`.
   *
   * The session-close run is the one that matters: IBKR clears its execution list overnight,
   * so a fill from the final minutes has until roughly midnight to be copied and no second
   * chance after that. Waiting out a 5-minute timer at exactly that moment is the one time
   * the cadence is not good enough.
   *
   * `publishReviewReady` runs only after a reconcile, and only here: this is the one place
   * that knows the ledger may have changed, and a round trip cannot close without a fill
   * landing first.
   */
  private async maybeReconcile(session: MarketSession): Promise<void> {
    const closing = this.lastSession === 'open' && session !== 'open';
    this.lastSession = session;

    if (!closing && Date.now() - this.lastReconcileAt < RECONCILE_INTERVAL_MS) return;
    this.lastReconcileAt = Date.now();
    if (closing) logger.info('[Scheduler] Session closed — reconciling fills');
    await reconcileFills();

    const reviewEvents = publishReviewReady(this.policyOf());
    if (reviewEvents.length > 0) this.route(reviewEvents);
  }

  private async runTick(): Promise<void> {
    if (!this.running || this.ticking) return;
    this.ticking = true;

    try {
      await this.tickOnce();
    } catch (err: any) {
      // Collect failures already surface as `Missing` observations and a `data_stale`
      // event; reaching here means something structural broke, so it is logged loudly
      // and the loop continues.
      logger.error('[Scheduler] Tick failed', err?.message ?? String(err));
    } finally {
      this.ticking = false;
      this.arm();
    }
  }

  private arm(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runTick();
    }, this.policyOf().triggers.tickIntervalMs);
  }
}

