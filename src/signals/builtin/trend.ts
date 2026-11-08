/**
 * The five trend signals. Moved here from `strategy/signals.ts` unchanged in arithmetic and
 * wording (pinned by tests/fixtures/signals/expected.json).
 *
 * **These five are one family.** Every one of them measures trend: an EMA spread, ADX with
 * price against EMA50, a 20-day breakout, a MACD histogram, and volume on an up day. In a
 * trending tape they move together, so a 5/5 tally is closer to one confirmation counted five
 * times than to five independent ones — which is why the composite averages scores rather
 * than counting votes. The learning layer measured all five on 2026-11-08: none showed a
 * reliable edge on five-day relative returns.
 *
 * Several of them decide "enough data" by whether an indicator produced output rather than by
 * a bar count, so they declare `minBars = 0` and keep that check, preserving their old answers
 * on short series exactly.
 */
import { Signal, type SignalContext, type Reading } from '../signal';

const INSUFFICIENT: Reading = { score: 0, detail: 'insufficient data' };

export class EmaMomentum extends Signal {
  readonly id = 'ema-momentum';
  readonly name = 'EMA Momentum';
  readonly family = 'trend' as const;
  readonly minBars = 0;
  readonly description = 'Spread of the fast EMA over the slow EMA, confirmed by RSI above 50.';
  protected compute(ctx: SignalContext): Reading {
    const s = ctx.policy.strategy;
    const fast = ctx.ema(s.emaFast), slow = ctx.ema(s.emaSlow), rsiSeries = ctx.rsi(s.rsiPeriod);
    if (fast.length < 2 || slow.length < 2 || rsiSeries.length === 0) return INSUFFICIENT;
    const emaF = fast[fast.length - 1], emaS = slow[slow.length - 1], currentRsi = rsiSeries[rsiSeries.length - 1];
    const spread = (emaF - emaS) / emaS * 100;
    let score: number;
    if (spread > 0) {
      score = Math.min(spread / 2, 0.5);   // cap at 0.5 from spread alone
      if (currentRsi >= 50) score += 0.3;
      if (currentRsi >= 60) score += 0.2;
    } else {
      score = Math.max(spread / 2, -0.5);
      if (currentRsi < 50) score -= 0.3;
      if (currentRsi < 40) score -= 0.2;
    }
    return { score, detail: `EMA spread ${spread >= 0 ? '+' : ''}${spread.toFixed(2)}%, RSI ${currentRsi.toFixed(1)}` };
  }
}

export class TrendStrength extends Signal {
  readonly id = 'trend-strength';
  readonly name = 'Trend Strength';
  readonly family = 'trend' as const;
  readonly minBars = 0;
  readonly description = 'ADX(14) for whether there is a trend, price against EMA(50) for its direction.';
  protected compute(ctx: SignalContext): Reading {
    const adxSeries = ctx.adx(14), ema50 = ctx.ema(50);
    if (adxSeries.length === 0 || ema50.length === 0) return INSUFFICIENT;
    const currentAdx = adxSeries[adxSeries.length - 1], currentEma50 = ema50[ema50.length - 1];
    const aboveEma50 = ctx.last.c > currentEma50;
    let score: number;
    if (currentAdx >= 25) {
      score = aboveEma50 ? 0.7 : -0.7;
      if (currentAdx >= 40) score = aboveEma50 ? 1.0 : -1.0;
    } else {
      score = aboveEma50 ? 0.2 : -0.2;   // weak or no trend: mild directional bias
    }
    return { score, detail: `ADX ${currentAdx.toFixed(1)}, price ${aboveEma50 ? 'above' : 'below'} EMA50 (${currentEma50.toFixed(2)})` };
  }
}

export class VolumeConfirmation extends Signal {
  readonly id = 'volume';
  readonly name = 'Volume';
  readonly family = 'trend' as const;
  readonly minBars = 21;
  readonly description = 'A volume surge against the 20-day average, signed by whether the day closed up.';
  protected compute({ bars }: SignalContext): Reading {
    const recent = bars.slice(-21);
    const avgVolume = recent.slice(0, 20).reduce((s, b) => s + b.v, 0) / 20;
    const lastBar = recent[recent.length - 1];
    if (avgVolume === 0) return { score: 0, detail: 'no volume data' };
    const volumeRatio = lastBar.v / avgVolume, isUpDay = lastBar.c > lastBar.o;
    let score = 0;
    if (volumeRatio >= 2.0) score = isUpDay ? 1.0 : -0.8;
    else if (volumeRatio >= 1.5) score = isUpDay ? 0.6 : -0.5;
    else if (volumeRatio >= 1.2) score = isUpDay ? 0.3 : -0.2;
    return { score, detail: `${volumeRatio.toFixed(1)}x avg vol, ${isUpDay ? 'up' : 'down'} day` };
  }
}

export class Breakout extends Signal {
  readonly id = 'breakout';
  readonly name = 'Breakout';
  readonly family = 'trend' as const;
  readonly minBars = 21;
  readonly description = 'Close against the prior 20-day high, stronger when the day\'s range is expanding.';
  protected compute({ bars }: SignalContext): Reading {
    const lookback = bars.slice(-21);
    const high20 = Math.max(...lookback.slice(0, 20).map(b => b.h));
    const currentPrice = lookback[lookback.length - 1].c;
    const recentTRs = lookback.slice(1).map((b, i) => {
      const prev = lookback[i];
      return Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c));
    });
    const avgTR = recentTRs.slice(0, 14).reduce((s, v) => s + v, 0) / 14;
    const atrExpanding = avgTR > 0 ? recentTRs[recentTRs.length - 1] / avgTR > 1.2 : false;
    let score = 0;
    if (currentPrice > high20) score = atrExpanding ? 0.9 : 0.6;
    else if (currentPrice > high20 * 0.98) score = 0.3;   // near a breakout
    else if ((high20 - currentPrice) / high20 * 100 > 5) score = -0.3;
    return { score, detail: `price ${currentPrice > high20 ? 'above' : `${((high20 - currentPrice) / high20 * 100).toFixed(1)}% below`} 20d high${atrExpanding ? ', ATR expanding' : ''}` };
  }
}

export class MacdHistogram extends Signal {
  readonly id = 'macd';
  readonly name = 'MACD';
  readonly family = 'trend' as const;
  readonly minBars = 0;
  readonly description = 'Sign and direction of the MACD(12,26,9) histogram.';
  protected compute(ctx: SignalContext): Reading {
    const result = ctx.macd(12, 26, 9);
    if (!result || result.histogram.length < 2) return INSUFFICIENT;
    const hist = result.histogram, current = hist[hist.length - 1], rising = current > hist[hist.length - 2];
    const scale = Math.abs(ctx.last.c) * 0.01;   // histogram as a share of 1% of price
    let score: number;
    if (current > 0 && rising) score = Math.min(1, Math.min(0.8, current / scale));
    else if (current > 0) score = 0.2;           // positive but fading
    else if (rising) score = -0.1;               // negative but improving
    else score = Math.max(-1, Math.max(-0.8, -(Math.abs(current) / scale)));
    return { score, detail: `histogram ${current >= 0 ? '+' : ''}${current.toFixed(3)} (${rising ? 'rising' : 'falling'})` };
  }
}

export const TREND_SIGNALS: readonly Signal[] = [
  new EmaMomentum(), new TrendStrength(), new VolumeConfirmation(), new Breakout(), new MacdHistogram(),
];
