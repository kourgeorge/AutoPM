/**
 * The mean-reversion family: "has this run too far from its own recent history?". Moved here
 * from `strategy/meanReversion.ts` unchanged (pinned by tests/fixtures/signals/expected.json).
 *
 * These read the same prices as the trend family; a different sign convention does not make
 * them independent evidence. Positive = stretched below recent history = expect a bounce.
 * Bollinger %B was removed long ago: with two-standard-deviation bands it equalled the z-score.
 */
import { reversalFilter } from '../../strategy/reversal';
import { Signal, clamp, type SignalContext, type Reading } from '../signal';

const BAND_PERIOD = 20;

export class ZScoreReversion extends Signal {
  readonly id = 'zscore-reversion';
  readonly name = 'Z-Score Reversion';
  readonly family = 'meanReversion' as const;
  readonly minBars = BAND_PERIOD;
  readonly description = 'How many standard deviations the close sits from its 20-day average, inverted.';
  protected compute({ bars }: SignalContext): Reading {
    const window = bars.slice(-BAND_PERIOD).map(b => b.c);
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    const sd = Math.sqrt(window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length);
    if (sd === 0) return { score: 0, detail: 'zero variance over window' };
    const z = (window[window.length - 1] - mean) / sd;
    return { score: clamp(-z / 2), detail: `z=${z.toFixed(2)} vs SMA${BAND_PERIOD} (${mean.toFixed(2)})` };
  }
}

export class ContrarianRsi extends Signal {
  readonly id = 'contrarian-rsi';
  readonly name = 'Contrarian RSI';
  readonly family = 'meanReversion' as const;
  readonly minBars = 0;
  readonly description = 'RSI read the opposite way to EMA Momentum: below 30 is oversold (bullish), above 70 overbought.';
  protected compute(ctx: SignalContext): Reading {
    const series = ctx.rsi(ctx.policy.strategy.rsiPeriod);
    if (series.length === 0) return { score: 0, detail: 'insufficient data' };
    const r = series[series.length - 1];
    const zone = r < 30 ? 'oversold' : r > 70 ? 'overbought' : 'neutral';
    return { score: clamp((50 - r) / 25), detail: `RSI ${r.toFixed(1)} (${zone})` };
  }
}

export class MonthlyReversal extends Signal {
  readonly id = 'monthly-reversal';
  readonly name = 'Monthly Reversal';
  readonly family = 'meanReversion' as const;
  readonly minBars = 0;   // reversalFilter writes its own "insufficient data" text
  readonly description = 'The 21-day return, inverted: a stock that already ran scores bearish. No size adjustment here.';
  protected compute({ bars }: SignalContext): Reading {
    const f = reversalFilter(bars as any, null);
    return { score: f.score, detail: f.detail };
  }
}

export const MEAN_REVERSION_SIGNALS: readonly Signal[] = [new ZScoreReversion(), new ContrarianRsi(), new MonthlyReversal()];
