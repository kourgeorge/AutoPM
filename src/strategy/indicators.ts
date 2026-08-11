import { Bar } from '../core/types';

// ── EMA ───────────────────────────────────────────────────────────────────────

export function ema(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];

  // Seed with SMA of first `period` values
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(seed);

  for (let i = period; i < values.length; i++) {
    result.push(values[i] * k + result[result.length - 1] * (1 - k));
  }

  return result;
}

// ── RSI ───────────────────────────────────────────────────────────────────────

export function rsi(closes: number[], period: number): number[] {
  if (closes.length < period + 1) return [];

  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  const result: number[] = [];

  // Seed: simple average of first `period` gains/losses
  let avgGain =
    changes.slice(0, period).reduce((s, c) => s + Math.max(c, 0), 0) / period;
  let avgLoss =
    changes.slice(0, period).reduce((s, c) => s + Math.max(-c, 0), 0) / period;

  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result.push(100 - 100 / (1 + rs0));

  for (let i = period; i < changes.length; i++) {
    const gain = Math.max(changes[i], 0);
    const loss = Math.max(-changes[i], 0);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(100 - 100 / (1 + rs));
  }

  return result;
}

// ── ATR ───────────────────────────────────────────────────────────────────────

export function atr(bars: Bar[], period: number): number[] {
  if (bars.length < period + 1) return [];

  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const { h, l } = bars[i];
    const prevClose = bars[i - 1].c;
    const tr = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
    trueRanges.push(tr);
  }

  // Seed with simple average
  let atrVal =
    trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = [atrVal];

  for (let i = period; i < trueRanges.length; i++) {
    atrVal = (atrVal * (period - 1) + trueRanges[i]) / period;
    result.push(atrVal);
  }

  return result;
}

// ── Crossover detection ───────────────────────────────────────────────────────

/**
 * Both series are SMA-seeded, so the slower one is shorter by exactly
 * (slowPeriod - fastPeriod) — but they END on the same bar. Alignment therefore has to
 * come from the TAIL of each series independently.
 *
 * Indexing both from `min(length)` compared emaFast at bar (n - slowPeriod + fastPeriod)
 * against emaSlow at the last bar, so a 9/21 pair on 60 closes was asking whether the
 * fast EMA twelve bars ago sat below the slow EMA today. The answer was noise, and the
 * entry signal built on it was noise too.
 */
function tailCross(fast: number[], slow: number[]): { prev: number; curr: number } | null {
  if (fast.length < 2 || slow.length < 2) return null;
  const f = fast.length - 1;
  const s = slow.length - 1;
  return { prev: fast[f - 1] - slow[s - 1], curr: fast[f] - slow[s] };
}

/** Returns true if fast just crossed above slow (bullish crossover). */
export function crossedAbove(fast: number[], slow: number[]): boolean {
  const c = tailCross(fast, slow);
  return c !== null && c.prev <= 0 && c.curr > 0;
}

/** Returns true if fast just crossed below slow (bearish crossover). */
export function crossedBelow(fast: number[], slow: number[]): boolean {
  const c = tailCross(fast, slow);
  return c !== null && c.prev >= 0 && c.curr < 0;
}
