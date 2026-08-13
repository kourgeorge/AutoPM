/**
 * L1 — OHLCV bars, provenance-stamped.
 *
 * `asOf` is the timestamp of the LAST bar, so a series that stopped updating
 * reads as stale even though the HTTP call succeeded.
 */

import type { Bar } from '../core/types';
import { getBarsRaw, Timeframe } from './yahoo';
import { Maybe, missingFrom, observe } from './types';

const SOURCE = 'yahoo' as const;

/**
 * Bars age by their own interval, not by the quote threshold — a daily series is
 * not stale at 90 seconds. Callers pass a threshold appropriate to the timeframe.
 */
export const DEFAULT_MAX_BAR_AGE_MS: Record<Timeframe, number> = {
  '1Min': 5 * 60_000,
  '5Min': 15 * 60_000,
  '15Min': 45 * 60_000,
  '1Hour': 3 * 60 * 60_000,
  '1Day': 4 * 24 * 60 * 60_000, // tolerates a long weekend
};

export async function collectBars(
  symbol: string,
  limit = 60,
  timeframe: Timeframe = '1Day',
  maxAgeMs: number = DEFAULT_MAX_BAR_AGE_MS[timeframe],
): Promise<Maybe<Bar[]>> {
  try {
    const bars = await getBarsRaw(symbol, limit, timeframe);
    return observe(bars, SOURCE, bars[bars.length - 1].t, maxAgeMs);
  } catch (err) {
    return missingFrom(SOURCE, err);
  }
}
