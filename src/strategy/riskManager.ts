import { AccountInfo, Position } from '../broker/IBroker';
import { getPolicy } from '../policy/load';
import { SignalResult } from '../core/types';

export function isAtMaxPositions(positions: Position[]): boolean {
  return positions.length >= getPolicy().risk.maxPositions;
}

export function hasEnoughBuyingPower(account: AccountInfo, signal: SignalResult, qty: number): boolean {
  return account.buyingPower >= qty * signal.price;
}

export type DailyLossState = 'ok' | 'breached' | 'unmeasurable';

export interface DailyLossStatus {
  state: DailyLossState;
  /** Percentage points, e.g. -3.20. Null when unmeasurable. */
  dayPnLPct: number | null;
  /** Percentage points, negative, e.g. -3. */
  thresholdPct: number;
  /** Why it cannot be measured, or null when it can. */
  reason: string | null;
}

/**
 * One answer to "are we past the daily loss limit", for both the alarm (the tick detector)
 * and the brake (the order path).
 *
 * THREE states, because a missing baseline is not a flat day and both call sites used to
 * turn it into a silent "fine". `buildAccountData` returned `dayPnLPct: null` so the
 * detector emitted nothing, and the order path substituted current equity for the baseline
 * so the change was exactly 0.00% and the guard could not trip. So on a cold start the
 * alarm and the brake were off at the same moment, for the same reason.
 *
 * A NEGATIVE baseline was worse than off. `0` is falsy, so the old `|| account.equity`
 * caught it, but a negative passed straight through and dividing by it FLIPS THE SIGN — a
 * loss read as a gain.
 *
 * Pure, and takes the threshold as a fraction rather than reading policy itself, for the
 * same reason `entrySignalVeto` does: the judgement is the part worth pinning in replay,
 * and the detector already has a `policy` in hand.
 *
 * UNIT TRAP: `policy.risk.maxDailyLossPct` is a FRACTION (0.03); everything returned here
 * is PERCENTAGE POINTS (-3.0), matching `AccountData.dayPnLPct`. Hence the `* 100`.
 */
export function dailyLossStatus(
  equity: number | null,
  startOfDayEquity: number,
  maxDailyLossPct: number,
): DailyLossStatus {
  const thresholdPct = -maxDailyLossPct * 100;
  const dayPnLPct = dayPnLPercent(equity, startOfDayEquity);

  if (dayPnLPct === null) {
    const reason =
      equity === null || !Number.isFinite(equity)
        ? 'no usable equity reading'
        : `start-of-day equity is ${startOfDayEquity} — the daily reset has not produced a baseline`;
    return { state: 'unmeasurable', dayPnLPct: null, thresholdPct, reason };
  }

  return {
    state: dayPnLPct < thresholdPct ? 'breached' : 'ok',
    dayPnLPct,
    thresholdPct,
    reason: null,
  };
}

/**
 * Today's move in PERCENTAGE POINTS, or null when there is nothing to measure.
 *
 * Split out of `dailyLossStatus` so `buildAccountData` can fill `AccountData.dayPnLPct`
 * from the same arithmetic without inventing a threshold it has no opinion about. It used
 * `pct(...)`, which returns null on a zero denominator but divides happily by a NEGATIVE
 * one — and dividing by a negative baseline flips the sign, so a loss displays as a gain.
 *
 * The null is load-bearing in both readers: it is what makes the detector say "cannot
 * measure" instead of staying silent, and what makes `get_account` report unknown instead
 * of a flat day.
 */
export function dayPnLPercent(equity: number | null, startOfDayEquity: number): number | null {
  if (equity === null || !Number.isFinite(equity)) return null;
  if (!Number.isFinite(startOfDayEquity) || startOfDayEquity <= 0) return null;
  return ((equity - startOfDayEquity) / startOfDayEquity) * 100;
}
