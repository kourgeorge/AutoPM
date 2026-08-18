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

// ── ADX (Average Directional Index) ─────────────────────────────────────────

/**
 * Computes ADX series from bars. Returns values 0–100; >25 typically means trending.
 * Uses Wilder's smoothing (same as ATR/RSI).
 */
export function adx(bars: Bar[], period = 14): number[] {
  if (bars.length < period * 2 + 1) return [];

  // Step 1: +DM, -DM, TR for each bar (starting at index 1)
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i].h - bars[i - 1].h;
    const downMove = bars[i - 1].l - bars[i].l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c),
    ));
  }

  // Step 2: Wilder-smooth +DM, -DM, TR over `period`
  const smooth = (arr: number[]): number[] => {
    let sum = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const result = [sum];
    for (let i = period; i < arr.length; i++) {
      sum = sum - sum / period + arr[i];
      result.push(sum);
    }
    return result;
  };

  const smoothPlusDM = smooth(plusDM);
  const smoothMinusDM = smooth(minusDM);
  const smoothTR = smooth(tr);

  // Step 3: +DI, -DI, DX
  const dx: number[] = [];
  for (let i = 0; i < smoothTR.length; i++) {
    if (smoothTR[i] === 0) { dx.push(0); continue; }
    const pdi = (smoothPlusDM[i] / smoothTR[i]) * 100;
    const mdi = (smoothMinusDM[i] / smoothTR[i]) * 100;
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100);
  }

  // Step 4: Smooth DX to get ADX
  if (dx.length < period) return [];
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = [adxVal];
  for (let i = period; i < dx.length; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
    result.push(adxVal);
  }

  return result;
}

// ── MACD ─────────────────────────────────────────────────────────────────────

export interface MACDResult {
  macdLine: number[];
  signalLine: number[];
  histogram: number[];
}

/**
 * Standard MACD(12, 26, 9). Returns aligned arrays — all same length.
 */
export function macd(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MACDResult | null {
  const emaFast = ema(closes, fastPeriod);
  const emaSlow = ema(closes, slowPeriod);

  if (emaFast.length === 0 || emaSlow.length === 0) return null;

  // Align: emaFast is longer than emaSlow by (slowPeriod - fastPeriod) entries.
  // Trim emaFast from the front to match emaSlow length.
  const offset = emaFast.length - emaSlow.length;
  const alignedFast = emaFast.slice(offset);

  const macdLine: number[] = [];
  for (let i = 0; i < emaSlow.length; i++) {
    macdLine.push(alignedFast[i] - emaSlow[i]);
  }

  const signalLine = ema(macdLine, signalPeriod);
  if (signalLine.length === 0) return null;

  // Trim macdLine to align with signalLine
  const macdTrimmed = macdLine.slice(macdLine.length - signalLine.length);
  const histogram = macdTrimmed.map((m, i) => m - signalLine[i]);

  return { macdLine: macdTrimmed, signalLine, histogram };
}
