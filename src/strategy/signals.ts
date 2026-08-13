/**
 * Multi-signal scoring for entry candidates.
 *
 * Inspired by Ang, Azimbayev & Kim (2026) "The Self-Driving Portfolio" — their
 * asset-class agents compute expected returns via 6+ methods, then an LLM judge
 * synthesizes them. Here the trader LLM IS the judge; this module provides the
 * competing signals as structured evidence for the LLM to weigh.
 *
 * Each signal method returns a score from -1 (strongly bearish) to +1 (strongly
 * bullish), plus a one-line detail string. All computation is deterministic —
 * the LLM never touches this code.
 */

import type { Bar } from '../core/types';
import type { Policy } from '../policy/types';
import { adx, ema, macd, rsi } from './indicators';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SignalScore {
  name: string;
  score: number;   // -1 to +1
  detail: string;  // one-line explanation
}

// ── Signal methods ───────────────────────────────────────────────────────────

/**
 * 1. EMA Momentum — spread of EMA(fast) vs EMA(slow) + RSI position.
 */
function emaMomentum(bars: Bar[], policy: Policy): SignalScore {
  const closes = bars.map(b => b.c);
  const fast = ema(closes, policy.strategy.emaFast);
  const slow = ema(closes, policy.strategy.emaSlow);
  const rsiSeries = rsi(closes, policy.strategy.rsiPeriod);

  if (fast.length < 2 || slow.length < 2 || rsiSeries.length === 0) {
    return { name: 'EMA Momentum', score: 0, detail: 'insufficient data' };
  }

  const emaF = fast[fast.length - 1];
  const emaS = slow[slow.length - 1];
  const currentRsi = rsiSeries[rsiSeries.length - 1];
  const spread = (emaF - emaS) / emaS * 100;

  // Score: spread direction + RSI confirmation
  let score = 0;
  if (spread > 0) {
    score = Math.min(spread / 2, 0.5); // cap at 0.5 from spread alone
    if (currentRsi >= 50) score += 0.3;
    if (currentRsi >= 60) score += 0.2;
  } else {
    score = Math.max(spread / 2, -0.5);
    if (currentRsi < 50) score -= 0.3;
    if (currentRsi < 40) score -= 0.2;
  }

  score = Math.max(-1, Math.min(1, score));
  return {
    name: 'EMA Momentum',
    score: parseFloat(score.toFixed(2)),
    detail: `EMA spread ${spread >= 0 ? '+' : ''}${spread.toFixed(2)}%, RSI ${currentRsi.toFixed(1)}`,
  };
}

/**
 * 2. Trend Strength — ADX(14) for trend presence + price vs EMA(50) for direction.
 */
function trendStrength(bars: Bar[]): SignalScore {
  const closes = bars.map(b => b.c);
  const adxSeries = adx(bars, 14);
  const ema50 = ema(closes, 50);

  if (adxSeries.length === 0 || ema50.length === 0) {
    return { name: 'Trend Strength', score: 0, detail: 'insufficient data' };
  }

  const currentAdx = adxSeries[adxSeries.length - 1];
  const currentPrice = closes[closes.length - 1];
  const currentEma50 = ema50[ema50.length - 1];
  const aboveEma50 = currentPrice > currentEma50;

  let score = 0;
  if (currentAdx >= 25) {
    // Strong trend — direction from price vs EMA(50)
    score = aboveEma50 ? 0.7 : -0.7;
    if (currentAdx >= 40) score = aboveEma50 ? 1.0 : -1.0;
  } else {
    // Weak/no trend — mild directional bias
    score = aboveEma50 ? 0.2 : -0.2;
  }

  return {
    name: 'Trend Strength',
    score: parseFloat(score.toFixed(2)),
    detail: `ADX ${currentAdx.toFixed(1)}, price ${aboveEma50 ? 'above' : 'below'} EMA50 (${currentEma50.toFixed(2)})`,
  };
}

/**
 * 3. Volume Confirmation — volume surge on up-days strengthens conviction.
 */
function volumeConfirmation(bars: Bar[]): SignalScore {
  if (bars.length < 21) {
    return { name: 'Volume', score: 0, detail: 'insufficient data' };
  }

  const recent = bars.slice(-21);
  const avgVolume = recent.slice(0, 20).reduce((s, b) => s + b.v, 0) / 20;
  const lastBar = recent[recent.length - 1];

  if (avgVolume === 0) {
    return { name: 'Volume', score: 0, detail: 'no volume data' };
  }

  const volumeRatio = lastBar.v / avgVolume;
  const isUpDay = lastBar.c > lastBar.o;

  let score = 0;
  if (volumeRatio >= 2.0) {
    score = isUpDay ? 1.0 : -0.8;
  } else if (volumeRatio >= 1.5) {
    score = isUpDay ? 0.6 : -0.5;
  } else if (volumeRatio >= 1.2) {
    score = isUpDay ? 0.3 : -0.2;
  } else if (volumeRatio < 0.7) {
    // Low volume — weak signal either way
    score = 0;
  }

  return {
    name: 'Volume',
    score: parseFloat(score.toFixed(2)),
    detail: `${volumeRatio.toFixed(1)}x avg vol, ${isUpDay ? 'up' : 'down'} day`,
  };
}

/**
 * 4. Breakout — price vs 20-day high with ATR expansion.
 */
function breakout(bars: Bar[]): SignalScore {
  if (bars.length < 21) {
    return { name: 'Breakout', score: 0, detail: 'insufficient data' };
  }

  const lookback = bars.slice(-21);
  const highs20 = lookback.slice(0, 20).map(b => b.h);
  const high20 = Math.max(...highs20);
  const lastBar = lookback[lookback.length - 1];
  const currentPrice = lastBar.c;

  // ATR expansion: compare last ATR to average ATR
  const recentTRs = lookback.slice(1).map((b, i) => {
    const prev = lookback[i];
    return Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c));
  });
  const avgTR = recentTRs.slice(0, 14).reduce((s, v) => s + v, 0) / 14;
  const lastTR = recentTRs[recentTRs.length - 1];
  const atrExpanding = avgTR > 0 ? lastTR / avgTR > 1.2 : false;

  let score = 0;
  if (currentPrice > high20) {
    score = 0.6;
    if (atrExpanding) score = 0.9;
  } else if (currentPrice > high20 * 0.98) {
    // Near breakout
    score = 0.3;
  } else {
    // Well below 20-day high
    const distPct = (high20 - currentPrice) / high20 * 100;
    if (distPct > 5) score = -0.3;
  }

  return {
    name: 'Breakout',
    score: parseFloat(score.toFixed(2)),
    detail: `price ${currentPrice > high20 ? 'above' : `${((high20 - currentPrice) / high20 * 100).toFixed(1)}% below`} 20d high${atrExpanding ? ', ATR expanding' : ''}`,
  };
}

/**
 * 5. MACD Histogram — direction and sign of MACD(12,26,9) histogram.
 */
function macdSignal(bars: Bar[]): SignalScore {
  const closes = bars.map(b => b.c);
  const result = macd(closes, 12, 26, 9);

  if (!result || result.histogram.length < 2) {
    return { name: 'MACD', score: 0, detail: 'insufficient data' };
  }

  const hist = result.histogram;
  const current = hist[hist.length - 1];
  const prev = hist[hist.length - 2];
  const rising = current > prev;

  let score = 0;
  if (current > 0 && rising) {
    score = Math.min(0.8, current / (Math.abs(closes[closes.length - 1]) * 0.01)); // normalize
    score = Math.min(score, 1.0);
  } else if (current > 0 && !rising) {
    score = 0.2; // positive but fading
  } else if (current < 0 && rising) {
    score = -0.1; // negative but improving
  } else {
    score = Math.max(-0.8, -(Math.abs(current) / (Math.abs(closes[closes.length - 1]) * 0.01)));
    score = Math.max(score, -1.0);
  }

  return {
    name: 'MACD',
    score: parseFloat(score.toFixed(2)),
    detail: `histogram ${current >= 0 ? '+' : ''}${current.toFixed(3)} (${rising ? 'rising' : 'falling'})`,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute all signal scores for a symbol given its bar history and policy.
 * Returns an array of 5 signal scores. All computation is deterministic.
 */
export function computeSignals(bars: Bar[], policy: Policy): SignalScore[] {
  return [
    emaMomentum(bars, policy),
    trendStrength(bars),
    volumeConfirmation(bars),
    breakout(bars),
    macdSignal(bars),
  ];
}

/**
 * One-line summary: "3/5 bullish, 1 neutral, 1 bearish"
 */
export function signalSummary(signals: SignalScore[]): string {
  let bullish = 0;
  let bearish = 0;
  let neutral = 0;

  for (const s of signals) {
    if (s.score > 0.1) bullish++;
    else if (s.score < -0.1) bearish++;
    else neutral++;
  }

  const parts: string[] = [];
  if (bullish > 0) parts.push(`${bullish}/${signals.length} bullish`);
  if (neutral > 0) parts.push(`${neutral} neutral`);
  if (bearish > 0) parts.push(`${bearish} bearish`);
  return parts.join(', ');
}
