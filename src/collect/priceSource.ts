/**
 * L1 — quotes, provenance-stamped.
 *
 * `prices/yahoo.ts` swallows failures into `undefined`, which is indistinguishable
 * from "price unchanged" once L2 computes events off it. These wrappers keep the
 * error and the data timestamp.
 */

import { getQuoteRaw } from '../prices/yahoo';
import { DEFAULT_MAX_AGE_MS, Maybe, missingFrom, observe } from './types';

const SOURCE = 'yahoo' as const;

export async function collectPrice(
  symbol: string,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): Promise<Maybe<number>> {
  try {
    const { price, asOf } = await getQuoteRaw(symbol);
    // No exchange timestamp reported: treat the fetch as the data time. The feed
    // is the authority on freshness and it declined to say, so we do not invent age.
    return observe(price, SOURCE, asOf ?? new Date().toISOString(), maxAgeMs);
  } catch (err) {
    return missingFrom(SOURCE, err);
  }
}

export async function collectPrices(
  symbols: string[],
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): Promise<Map<string, Maybe<number>>> {
  const entries = await Promise.all(
    symbols.map(async (s) => [s, await collectPrice(s, maxAgeMs)] as const),
  );
  return new Map(entries);
}
