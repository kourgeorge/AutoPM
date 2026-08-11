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
import { etDate } from '../core/time';
import { getPolicy } from '../policy/load';
import type { Policy } from '../policy/types';
import { getState, resetDailyState } from '../state/state';
import { collectAndCompute } from './compute';
import { DETECTORS } from './detectors';
import { publishTick, type Detector, type TriggerEvent } from './eventBus';

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

  resetDailyState(account.value.equity, today);
  logger.info(`[Scheduler] Daily reset for ${today} — start equity $${account.value.equity.toFixed(2)}`);
  return true;
}

export class FeatureScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private ticking = false;
  private readonly detectors: Detector[];
  private readonly route: EventRouter;
  private readonly policyOf: () => Policy;

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
    return events;
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

/**
 * Observe-only router — logs what WOULD have been routed and wakes nobody.
 *
 * `createLiveRouter` has superseded it in `daemon.ts`. Kept because it makes rollback a
 * one-line edit there: if live routing turns out to wake too often, the pipeline can be put
 * back to observing without touching anything else.
 */
export const observeOnlyRouter: EventRouter = (events) => {
  for (const event of events) {
    logger.info(
      `[L2 observe] ${event.kind} ${event.severity} ${event.symbol ?? '-'} w${event.wakeCount} — ${event.headline}`,
    );
  }
  logger.info(`[L2 observe] ${events.length} event(s)`);
};
