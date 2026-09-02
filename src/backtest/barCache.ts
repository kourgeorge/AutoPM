/**
 * L1 — historical daily bar cache for the backtest engine.
 *
 * `data/historicalBars/<SYMBOL>.json` per symbol, as `Bar[]` sorted ascending by time.
 * No TTL: a closed trading day's bar never changes, so deleting the file is the only
 * invalidation (same reasoning as `src/collect/sectorCache.ts`).
 *
 * Neither `src/tools/alpacaDataTools.ts`'s `getStockBars` nor `src/collect/barSource.ts`'s
 * `collectBars` paginate — both make one bounded request. A 10-year range needs more bars
 * than a single page, so this fetches one symbol at a time and follows `next_page_token`.
 * Alpaca sorts multi-symbol paginated responses symbol-first-then-timestamp, so fetching
 * more than one symbol per request risks exhausting the page limit on the first symbol
 * before ever reaching the next — fetching one symbol per request sidesteps that entirely.
 */

import fs from 'fs';
import path from 'path';
import { writeFileAtomic } from '../core/fsAtomic';
import { DATA_DIR, ensureDataDir } from '../core/paths';
import { logger } from '../core/logger';
import { alpacaData } from '../core/alpacaHttp';
import type { Bar } from '../core/types';

const CACHE_DIR = path.join(DATA_DIR, 'historicalBars');

/** Loaded lazily per symbol, then authoritative in memory for the process lifetime. */
const _cache: Map<string, Bar[]> = new Map();

function cacheFile(symbol: string): string {
  return path.join(CACHE_DIR, `${symbol}.json`);
}

function load(symbol: string): Bar[] {
  const cached = _cache.get(symbol);
  if (cached) return cached;
  let loaded: Bar[] = [];
  try {
    const file = cacheFile(symbol);
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) loaded = parsed;
    }
  } catch (err: any) {
    logger.warn(`[BarCache] Unreadable cache for ${symbol} — starting empty: ${err.message}`);
  }
  _cache.set(symbol, loaded);
  return loaded;
}

function save(symbol: string, bars: Bar[]): void {
  try {
    ensureDataDir(CACHE_DIR);
    writeFileAtomic(cacheFile(symbol), JSON.stringify(bars, null, 2));
  } catch (err: any) {
    logger.warn(`[BarCache] Write failed for ${symbol} — in-memory cache still valid: ${err.message}`);
  }
}

interface AlpacaStockBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n: number;
  vw: number;
}

interface AlpacaBarsResponse {
  bars: Record<string, AlpacaStockBar[]>;
  next_page_token: string | null;
}

/**
 * Free/paper Alpaca accounts get a 403 ("subscription does not permit querying recent SIP
 * data") when a `/v2/stocks/bars` request's `end` lands within the last couple of trading
 * days — verified directly: a request ending 2 calendar days back succeeds, 1 day back 403s.
 * The full historical SIP tape back to 2016 (and earlier) is NOT restricted — only that
 * trailing window is. A 5-day buffer clears weekends/holidays with room to spare; losing the
 * last few days of a 10-year backtest is irrelevant.
 *
 * `feed: 'iex'` was tried first and reverted: Alpaca's IEX historical archive for most
 * symbols only starts around 2020-07-27 regardless of the symbol's actual listing date
 * (confirmed for AAPL, which has traded since 1980) — it would have silently truncated every
 * 10-year request to ~6 years and dropped the 2020 COVID crash the backtest plan explicitly
 * wants covered. SIP with the end-date buffer below gets the real full range.
 */
const RECENT_DATA_BUFFER_DAYS = 5;

function safeEnd(end: string): string {
  const cutoff = new Date(Date.now() - RECENT_DATA_BUFFER_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return end < cutoff ? end : cutoff;
}

const MAX_RETRIES = 5;
const RETRYABLE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * The sweep hits Alpaca hard enough (81 grid points x 2 splits x 47 symbols, each a
 * paginated fetch on a cache miss) to draw a 429, and a long-running process is also exposed
 * to plain transient network failures (ETIMEDOUT etc. — hit this once too, 2026-08-31). Retry
 * both; give up on anything else. `alpacaHttp.ts` deliberately does no retry/translation of
 * its own — "each caller wants something different from a failure" — so an untranslated axios
 * error here becomes an unhandled rejection, and Node prints the FULL error object on its way
 * out, including the request's `APCA-API-KEY-ID`/`APCA-API-SECRET-KEY` headers in plaintext
 * (hit this once too: 2026-08-31, leaked into a log file). Every failure path below must throw
 * a plain `Error` with just status + message.
 */
function isRetryable(err: any): boolean {
  return err?.response?.status === 429 || RETRYABLE_CODES.has(err?.code);
}

function throwSanitized(symbol: string, err: any): never {
  const status = err?.response?.status;
  const message = err?.response?.data?.message ?? err?.message ?? 'unknown error';
  throw new Error(`Alpaca bars fetch failed for ${symbol}${status ? ` (${status})` : ''}: ${message}`);
}

/** Fetches every daily bar for one symbol in [start, end], following pagination to the end. */
async function fetchAllBars(symbol: string, start: string, end: string): Promise<Bar[]> {
  const out: Bar[] = [];
  let pageToken: string | undefined;
  do {
    let resp;
    for (let attempt = 0; ; attempt++) {
      try {
        resp = await alpacaData.get<AlpacaBarsResponse>('/v2/stocks/bars', {
          params: {
            symbols: symbol,
            timeframe: '1Day',
            start,
            end,
            limit: 10000,
            adjustment: 'raw',
            sort: 'asc',
            feed: 'sip',
            page_token: pageToken,
          },
        });
        break;
      } catch (err: any) {
        if (isRetryable(err) && attempt < MAX_RETRIES) {
          const delayMs = 1000 * 2 ** attempt;
          const reason = err?.response?.status === 429 ? '429' : err.code;
          logger.warn(`[BarCache] ${reason} fetching ${symbol}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        throwSanitized(symbol, err);
      }
    }
    const bars = resp.data.bars[symbol] ?? [];
    for (const b of bars) out.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    pageToken = resp.data.next_page_token ?? undefined;
  } while (pageToken);
  return out;
}

/**
 * Serves cached bars covering [start, end], fetching only what the cache doesn't already
 * have. Cache coverage is judged by the first/last cached bar's date against the requested
 * range — a partial-range cache (e.g. one earlier fetch with a later `start`) triggers a
 * full re-fetch of the whole range rather than trying to splice ranges together, since a
 * backtest always asks for the same fixed 10-year window repeatedly.
 *
 * `end` is clamped away from "now" by `safeEnd` before either the cache-coverage check or
 * the fetch — see the comment on `RECENT_DATA_BUFFER_DAYS` above.
 */
export async function getHistoricalBars(symbol: string, start: string, end: string): Promise<Bar[]> {
  const clampedEnd = safeEnd(end);
  const cached = load(symbol);
  if (cached.length > 0) {
    const firstDate = cached[0].t.slice(0, 10);
    const lastDate = cached[cached.length - 1].t.slice(0, 10);
    if (firstDate <= start && lastDate >= clampedEnd) {
      return cached.filter(b => b.t.slice(0, 10) >= start && b.t.slice(0, 10) <= clampedEnd);
    }
  }

  const fetched = await fetchAllBars(symbol, start, clampedEnd);
  _cache.set(symbol, fetched);
  save(symbol, fetched);
  return fetched;
}
