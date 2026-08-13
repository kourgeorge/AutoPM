/**
 * L1 — quotes, provenance-stamped.
 *
 * Primary: Alpaca /v2/stocks/snapshots (bulk, one call for all symbols).
 * Fallback: Yahoo Finance (per-symbol, used when Alpaca fails for a symbol).
 *
 * The fallback is per-symbol so a single Yahoo failure does not pull down
 * symbols that Alpaca already answered. Provenance (source field) records
 * which feed each price came from.
 */

import axios from 'axios';
import { config } from '../core/config';
import { marketSession } from '../core/time';
import { getQuoteRaw } from './yahoo';
import { DEFAULT_MAX_AGE_MS, Maybe, missingFrom, observe } from './types';

/**
 * Alpaca returns nanosecond-precision timestamps ("...723490207Z", 9 decimal
 * digits). Date.parse() returns NaN for anything beyond milliseconds on some
 * runtimes, which makes ageMs = NaN and observe() flags every price as stale.
 * Truncate to 3 fractional digits before any date arithmetic.
 */
function toMs(ts: string): string {
  return ts.replace(/(\.\d{3})\d+/, '$1');
}

/**
 * When the market is not in its regular session the last-trade timestamp can be
 * hours old — that is not a stale feed, it is the most recent price available.
 * Use the fetch time as asOf so the 90-second freshness gate does not fire
 * spuriously overnight and after close.
 */
function effectiveAsOf(dataAsOf: string): string {
  const normalized = toMs(dataAsOf);
  return marketSession() === 'open' ? normalized : new Date().toISOString();
}

const ALPACA_SOURCE = 'alpaca' as const;
const YAHOO_SOURCE  = 'yahoo'  as const;

/** A price and the timestamp that price itself carries. The pair never splits. */
interface Candidate {
  price: number;
  asOf: string;
}

function tradeCandidate(snap: any): Candidate | null {
  const price = snap?.latestTrade?.p;
  const asOf = snap?.latestTrade?.t;
  return typeof price === 'number' && Number.isFinite(price) && typeof asOf === 'string'
    ? { price, asOf }
    : null;
}

function quoteCandidate(snap: any): Candidate | null {
  const q = snap?.latestQuote;
  if (q?.ap == null || q?.bp == null || typeof q?.t !== 'string') return null;
  const mid = (q.ap + q.bp) / 2;
  return Number.isFinite(mid) && mid > 0 ? { price: mid, asOf: q.t } : null;
}

/** Unparseable timestamps sort oldest, so they lose to anything readable. */
function stamp(c: Candidate): number {
  const t = Date.parse(toMs(c.asOf));
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * Whichever candidate is newer.
 *
 * On IEX the last *trade* is the sparse half: a liquid name can go minutes between
 * prints at midday — AMD's entire IEX session is a few thousand prints on ~2% of
 * consolidated volume — while its quote keeps updating every second. Preferring the
 * trade unconditionally therefore stamped a usable price with a minutes-old timestamp,
 * and `observe()` read that as a dead feed: one `data_stale` warn per quiet symbol,
 * for a feed that was answering fine.
 *
 * Price and `asOf` travel together by construction. Stamping a trade price with the
 * quote's clock would leave the freshness gate measuring an age its value never had.
 */
function freshest(a: Candidate | null, b: Candidate | null): Candidate | null {
  if (!a) return b;
  if (!b) return a;
  return stamp(b) > stamp(a) ? b : a;
}

const alpacaData = axios.create({
  baseURL: config.alpaca.dataUrl,
  headers: {
    'APCA-API-KEY-ID':     config.alpaca.keyId,
    'APCA-API-SECRET-KEY': config.alpaca.secretKey,
  },
});

/**
 * Fetch latest prices for a batch of symbols from Alpaca snapshots.
 * Returns a map of symbol → { price, asOf } for every symbol that succeeded.
 * Throws if the HTTP call itself fails (caller decides fallback strategy).
 */
async function fetchAlpacaSnapshots(
  symbols: string[],
): Promise<Map<string, { price: number; asOf: string }>> {
  const res = await alpacaData.get<Record<string, any>>('/v2/stocks/snapshots', {
    params: { symbols: symbols.join(','), feed: 'iex' },
  });

  const out = new Map<string, { price: number; asOf: string }>();
  for (const [symbol, snap] of Object.entries(res.data ?? {})) {
    // Last print, or the mid of the current bid/ask — whichever is more recent.
    const pick = freshest(tradeCandidate(snap), quoteCandidate(snap));
    if (pick) {
      out.set(symbol, { price: pick.price, asOf: effectiveAsOf(pick.asOf) });
    }
  }
  return out;
}

async function collectPriceYahoo(
  symbol: string,
  maxAgeMs: number,
): Promise<Maybe<number>> {
  try {
    const { price, asOf } = await getQuoteRaw(symbol);
    return observe(price, YAHOO_SOURCE, effectiveAsOf(asOf ?? new Date().toISOString()), maxAgeMs);
  } catch (err) {
    return missingFrom(YAHOO_SOURCE, err);
  }
}

export async function collectPrice(
  symbol: string,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): Promise<Maybe<number>> {
  // Single-symbol path: try Alpaca snapshot, fall back to Yahoo.
  try {
    const snaps = await fetchAlpacaSnapshots([symbol]);
    const hit = snaps.get(symbol);
    if (hit) return observe(hit.price, ALPACA_SOURCE, hit.asOf, maxAgeMs);
  } catch {
    // Alpaca unavailable — fall through to Yahoo
  }
  return collectPriceYahoo(symbol, maxAgeMs);
}

export async function collectPrices(
  symbols: string[],
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): Promise<Map<string, Maybe<number>>> {
  const result = new Map<string, Maybe<number>>();

  // ── 1. Try Alpaca bulk snapshot ──────────────────────────────────────────
  let alpacaHits = new Map<string, { price: number; asOf: string }>();
  try {
    alpacaHits = await fetchAlpacaSnapshots(symbols);
  } catch {
    // Entire Alpaca call failed — all symbols fall through to Yahoo
  }

  for (const [symbol, hit] of alpacaHits) {
    result.set(symbol, observe(hit.price, ALPACA_SOURCE, hit.asOf, maxAgeMs));
  }

  // ── 2. Yahoo fallback for any symbol Alpaca didn't return ────────────────
  const missing = symbols.filter(s => !result.has(s));
  if (missing.length > 0) {
    await Promise.all(
      missing.map(async s => {
        result.set(s, await collectPriceYahoo(s, maxAgeMs));
      }),
    );
  }

  return result;
}
