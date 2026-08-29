/**
 * Short-term reversal — the one reading in this system that is allowed to disagree.
 *
 * ## Why this exists apart from `signals.ts`
 *
 * The five scores in `computeSignals` are trend measured five ways: an EMA spread, ADX with
 * price against EMA50, a 20-day breakout, a MACD histogram, and volume on an up day. In a
 * trending tape they move together, so their pairwise correlation is high and "4/5 bullish"
 * is closer to one confirmation counted four times than to four independent ones. Averaging
 * them (`SignalTally.composite`) stops the count from inflating, but it cannot manufacture a
 * second opinion out of five copies of the first.
 *
 * Short-term reversal is that second opinion, and it is valuable precisely because it is
 * contrarian: last month's biggest winners tend to give some of it back, so this reading goes
 * NEGATIVE exactly where the five go positive. It is one of the strongest measured effects in
 * Gu, Kelly & Xiu's comparison of machine-learning return predictors, and it survives there
 * as an interaction with size rather than on its own.
 *
 * ## Why it is a filter and not a sixth signal
 *
 * Reversal in the literature is a MONTHLY effect. It says nothing about whether today is a
 * good day to buy, so putting it in `computeSignals` would be wrong twice over: it would drag
 * the composite — a same-day trend reading — toward a horizon it does not measure, and in a
 * healthy uptrend it would fight the five signals by construction and mute every strong setup.
 *
 * So it answers a narrower question, asked after the trend signals have already said yes:
 * *has this already run too far to chase?* A `chasing: true` is a reason to skip or wait for
 * a pullback, never on its own a reason to enter.
 *
 * ## The size interaction
 *
 * The chase threshold scales with market cap, because that is what the effect measures: the
 * same +12% month is far more likely to mean-revert in a small cap than in a mega cap, where
 * it is more often just a trend. Thresholds are a judgement, stated in one table below rather
 * than scattered, and the size leg is the only thing here that is not bar arithmetic — so
 * when market cap is unknown the bucket says `unknown`, a middle threshold is used, and the
 * detail line says the size adjustment did not happen. An unknown cap is never quietly
 * treated as a large one.
 */

import type { Bar } from '../core/types';

/**
 * Trading days in the reversal window. 21 ≈ one month, the horizon the effect is measured
 * over. Well inside `strategy.minBars` (50), so anything scoreable has the history.
 */
export const REVERSAL_LOOKBACK = 21;

export type SizeBucket = 'mega' | 'large' | 'mid' | 'small' | 'unknown';

/**
 * How far a name may run over the window before entering it counts as chasing, in percent.
 *
 * A judgement, not an arithmetic fact — hence one table, read by both the score and the
 * `chasing` flag, so the two can never disagree about where the line is. `unknown` sits at
 * the large-cap value deliberately: it is the middle of the range, and picking the mega-cap
 * end would make a missing market cap the most permissive case.
 */
const CHASE_THRESHOLD_PCT: Record<SizeBucket, number> = {
  mega: 15,
  large: 12,
  mid: 10,
  small: 8,
  unknown: 12,
};

/** Bucket edges in dollars. Conventional index boundaries, not tuned. */
export function sizeBucket(marketCap: number | null | undefined): SizeBucket {
  if (marketCap == null || !Number.isFinite(marketCap) || marketCap <= 0) return 'unknown';
  if (marketCap >= 200e9) return 'mega';
  if (marketCap >= 10e9) return 'large';
  if (marketCap >= 2e9) return 'mid';
  return 'small';
}

export interface ReversalFilter {
  /** Return over the last `REVERSAL_LOOKBACK` bars, in percent. Null when history is short. */
  oneMonthReturnPct: number | null;
  sizeBucket: SizeBucket;
  /** The cap the bucket came from, so a reader can check the bucket rather than trust it. */
  marketCap: number | null;
  chaseThresholdPct: number;
  /**
   * -1..+1, and it reads the OPPOSITE way to a signal score: negative means the name has
   * already run and chasing it is the risk, positive means it has pulled back and reversal is
   * a tailwind. Deliberately excluded from `SignalTally.composite`.
   */
  score: number;
  /** The move cleared this size bucket's threshold. The filter's actual verdict. */
  chasing: boolean;
  detail: string;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Compute the reversal filter for one symbol.
 *
 * Pure and synchronous over bars plus one optional number, so the 60s tick can call it for
 * every watchlist row (`compute.ts`'s NO-NEW-MATH neighbours) and the replay harness gets the
 * same answer with no market cap on disk.
 *
 * `marketCap` is whatever the caller already has — the fundamentals cache, a fetched
 * `Fundamentals.liquidity.marketCap`, or nothing. Omitting it is a supported call, not a
 * degraded one; it costs the size adjustment and says so.
 */
export function reversalFilter(bars: Bar[], marketCap: number | null = null): ReversalFilter {
  const bucket = sizeBucket(marketCap);
  const threshold = CHASE_THRESHOLD_PCT[bucket];
  const cap = bucket === 'unknown' ? null : (marketCap as number);
  const sizeNote = bucket === 'unknown'
    ? `market cap unknown, no size adjustment, chase above +${threshold}%`
    : `${bucket} cap, chase above +${threshold}%`;

  if (bars.length < REVERSAL_LOOKBACK + 1) {
    return {
      oneMonthReturnPct: null,
      sizeBucket: bucket,
      marketCap: cap,
      chaseThresholdPct: threshold,
      score: 0,
      chasing: false,
      detail: `insufficient data: ${bars.length} bars, need ${REVERSAL_LOOKBACK + 1}`,
    };
  }

  const from = bars[bars.length - 1 - REVERSAL_LOOKBACK].c;
  const to = bars[bars.length - 1].c;

  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to)) {
    return {
      oneMonthReturnPct: null,
      sizeBucket: bucket,
      marketCap: cap,
      chaseThresholdPct: threshold,
      score: 0,
      chasing: false,
      detail: 'unusable closes in the reversal window',
    };
  }

  const ret = (to - from) / from * 100;

  // Continuous, and it reaches -1 at twice the threshold rather than at it: the threshold is
  // where chasing STARTS, not where the evidence is maxed out.
  const score = clamp(-ret / (2 * threshold), -1, 1);

  return {
    oneMonthReturnPct: parseFloat(ret.toFixed(2)),
    sizeBucket: bucket,
    marketCap: cap,
    chaseThresholdPct: threshold,
    score: parseFloat(score.toFixed(2)),
    chasing: ret > threshold,
    detail: `${ret >= 0 ? '+' : ''}${ret.toFixed(1)}% over ${REVERSAL_LOOKBACK} bars (${sizeNote})`,
  };
}
