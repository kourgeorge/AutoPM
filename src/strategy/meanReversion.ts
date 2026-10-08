/**
 * Mean-reversion / statistical signal family. These readings share price history with the
 * trend family; a different sign convention does not establish statistical independence.
 * Every leg here answers "has this run too far from its own recent history?"
 * rather than "is this trending?". Same shape as `signals.ts` (`SignalScore[]`, reuses its
 * `signalTally`/`signalSummary`, which are generic) so it can be composited and consumed the
 * same way.
 *
 * Sign convention matches the rest of the codebase: positive = bullish = favourable for a long
 * entry (the system is long-only). Stretched below recent history scores bullish here (expect
 * reversion up); stretched above scores bearish.
 */

import type { Bar } from '../core/types';
import type { Policy } from '../policy/types';
import { rsi } from './indicators';
import { reversalFilter } from './reversal';
import type { SignalScore } from './signals';

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function sma(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stdev(values: number[], mean: number): number {
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

const BAND_PERIOD = 20;

/**
 * 1. Z-score reversion — `(price - SMA20) / stdev20`, inverted.
 */
function zScoreReversion(bars: Bar[]): SignalScore {
  if (bars.length < BAND_PERIOD) {
    return { name: 'Z-Score Reversion', score: 0, detail: 'insufficient data' };
  }
  const window = bars.slice(-BAND_PERIOD).map(b => b.c);
  const mean = sma(window);
  const sd = stdev(window, mean);
  const price = window[window.length - 1];

  if (sd === 0) {
    return { name: 'Z-Score Reversion', score: 0, detail: 'zero variance over window' };
  }
  const z = (price - mean) / sd;
  const score = clamp(-z / 2, -1, 1);
  return {
    name: 'Z-Score Reversion',
    score: parseFloat(score.toFixed(2)),
    detail: `z=${z.toFixed(2)} vs SMA${BAND_PERIOD} (${mean.toFixed(2)})`,
  };
}

/**
 * 2. Contrarian RSI — reuses `rsi()` from `indicators.ts`, scored the opposite way
 * `emaMomentum` in `signals.ts` uses it: there, high RSI confirms a trend; here, RSI < 30 is
 * bullish/oversold and RSI > 70 is bearish/overbought.
 */
function contrarianRsi(bars: Bar[], policy: Policy): SignalScore {
  const closes = bars.map(b => b.c);
  const rsiSeries = rsi(closes, policy.strategy.rsiPeriod);
  if (rsiSeries.length === 0) {
    return { name: 'Contrarian RSI', score: 0, detail: 'insufficient data' };
  }
  const currentRsi = rsiSeries[rsiSeries.length - 1];
  const score = clamp((50 - currentRsi) / 25, -1, 1);
  const zone = currentRsi < 30 ? 'oversold' : currentRsi > 70 ? 'overbought' : 'neutral';
  return {
    name: 'Contrarian RSI',
    score: parseFloat(score.toFixed(2)),
    detail: `RSI ${currentRsi.toFixed(1)} (${zone})`,
  };
}

/**
 * 3. Monthly reversal — reuses `reversalFilter()` from `strategy/reversal.ts` verbatim, the
 * same "second opinion" `signals.ts` deliberately keeps outside its own composite. For a
 * dedicated mean-reversion composite it belongs as a full member. `marketCap` is always
 * `null` here — no fundamentals fetch exists at this level, so the size-adjusted chase
 * threshold always falls back to the `unknown` bucket.
 */
function monthlyReversal(bars: Bar[]): SignalScore {
  const filter = reversalFilter(bars, null);
  return { name: 'Monthly Reversal', score: filter.score, detail: filter.detail };
}

/**
 * Compute all mean-reversion signal scores for a symbol given its bar history and policy.
 * Returns three readings. Bollinger %B was removed: with two-standard-deviation bands
 * its score was exactly the z-score reading and double-weighted the same measurement.
 */
export function computeMeanReversionSignals(bars: Bar[], policy: Policy): SignalScore[] {
  return [
    zScoreReversion(bars),
    contrarianRsi(bars, policy),
    monthlyReversal(bars),
  ];
}
