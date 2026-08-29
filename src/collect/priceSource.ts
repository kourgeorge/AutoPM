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

import { alpacaData, alpacaTimeToMs, SIP_EMBARGO_MS } from '../core/alpacaHttp';
import { marketSession } from '../core/time';
import { getQuoteRaw } from './yahoo';
import {
  DEFAULT_MAX_AGE_MS,
  Maybe,
  missingFrom,
  observe,
  type Observation,
  type SourceId,
} from './types';

/**
 * Alpaca's nanosecond timestamps, normalised to something `observe()` can subtract. The
 * truncation rule itself lives with the rest of the Alpaca wire format in
 * `core/alpacaHttp.ts`; an unreadable stamp is passed through unchanged so `observe()` still
 * sees a NaN age and flags the value stale rather than inventing a fresh one.
 */
function toMs(ts: string): string {
  const ms = alpacaTimeToMs(ts);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : ts;
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
  /** See `tradeConfirmed` on `Observation` — this is where that field is decided. */
  tradeConfirmed: boolean;
}

/**
 * How wide the book may be before its midpoint stops being a price.
 *
 * A liquid name quotes pennies wide — CRM's normal spread is around 0.02% — so a full
 * percentage point is generous by two orders of magnitude and still catches the artifact
 * this exists for: measured 2026-08-26T20:01Z, one minute after the close, CRM quoted
 * bid 208.90 / ask 213.94, a 2.4% book whose midpoint sat $5.11 above the day's high.
 *
 * Module constants rather than `policy.yaml` keys, for the reason `RECONCILE_INTERVAL_MS`
 * is: policy holds the numbers an operator tunes to change how the system TRADES, and
 * these change only how it reads a feed. Erring strict is cheap — a rejected midpoint
 * costs a high-water mark that waits for the next print, never a missed trade.
 */
const MAX_SPREAD_PCT = 1.0;

/**
 * How far outside the day's traded range a midpoint may sit and still be believed.
 *
 * Not zero, because `feed: 'iex'` sees a fraction of consolidated volume, so its daily bar
 * is a slightly narrower window than the tape's: measured the same afternoon, CRM's IEX
 * high was 206.31 against a consolidated 206.44, a gap of 0.06%. The tolerance absorbs
 * that partial view without admitting the 2.5% excursion above it.
 */
const RANGE_TOLERANCE_PCT = 0.25;

/**
 * Does trading corroborate this midpoint?
 *
 * Two questions, both answered from data already in the same snapshot response — no extra
 * call, no second source to disagree with:
 *
 *  1. Is the book tight enough that its middle is a price anyone would deal at?
 *  2. Did the day's tape actually reach here?
 *
 * A missing or unreadable daily bar answers NO, not "assume so". The whole point of the
 * field is that a number nothing corroborates must not set a permanent record, and a
 * snapshot with no bar corroborates nothing.
 */
function midpointConfirmed(mid: number, q: any, bar: any): boolean {
  const spreadPct = ((q.ap - q.bp) / mid) * 100;
  if (!Number.isFinite(spreadPct) || spreadPct > MAX_SPREAD_PCT) return false;

  const high = bar?.h;
  const low = bar?.l;
  if (typeof high !== 'number' || !(high > 0)) return false;
  if (typeof low !== 'number' || !(low > 0)) return false;

  const tol = RANGE_TOLERANCE_PCT / 100;
  return mid >= low * (1 - tol) && mid <= high * (1 + tol);
}

/** A print is a trade that happened, so it is confirmed by definition. */
function tradeCandidate(snap: any): Candidate | null {
  const price = snap?.latestTrade?.p;
  const asOf = snap?.latestTrade?.t;
  return typeof price === 'number' && Number.isFinite(price) && typeof asOf === 'string'
    ? { price, asOf, tradeConfirmed: true }
    : null;
}

/**
 * The midpoint of the book — but only when there IS a book on both sides.
 *
 * BOTH sides must be above zero, and the guard that used to read `ap == null || bp == null`
 * was not enough: after the close the ask side of an IEX book empties and Alpaca reports the
 * missing side as `0` rather than omitting it. Zero is not null, so it passed, and the
 * midpoint of a real price and a blank is HALF the real price. Measured 2026-08-13 20:00Z:
 *
 *   TSLA  bid 324.20  ask 0  ->  mid 162.100
 *   NVDA  bid 213.75  ask 0  ->  mid 106.875
 *
 * Both of those are exactly the `sessionLow` values that reached `state.json`, because the
 * `mid > 0` check downstream cannot tell half a price from a price. Worse, the emptied book
 * is stamped SECONDS AFTER the closing print (NVDA: trade 19:59:59.998, quote 20:00:04.976),
 * so the halved figure also won the freshness comparison and displaced the genuine close.
 * `sessionLow` is monotonic with a single writer, so it then rendered "MAE -52.2%" into every
 * subsequent cycle, which the model correctly rejected as impossible three times over.
 *
 * One side is not a market. Returning null lets the last real trade stand, which is the
 * right price for a closed session anyway.
 */
function quoteCandidate(snap: any): Candidate | null {
  const q = snap?.latestQuote;
  if (typeof q?.t !== 'string') return null;
  if (!(q.bp > 0) || !(q.ap > 0)) return null;
  const mid = (q.ap + q.bp) / 2;
  if (!Number.isFinite(mid)) return null;
  // Still returned when unconfirmed: it may be the only number there is, and reporting no
  // price at all reads as a dead feed. What it loses is the right to set a record.
  return { price: mid, asOf: q.t, tradeConfirmed: midpointConfirmed(mid, q, snap?.dailyBar) };
}

/** Unparseable timestamps sort oldest, so they lose to anything readable. */
function stamp(c: Candidate): number {
  const t = Date.parse(toMs(c.asOf));
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * Choose between the last print and the current book.
 *
 * Newer usually wins. On IEX the last *trade* is the sparse half: a liquid name can go
 * minutes between prints at midday — AMD's entire IEX session is a few thousand prints on
 * ~2% of consolidated volume — while its quote keeps updating every second. Preferring the
 * trade unconditionally therefore stamped a usable price with a minutes-old timestamp, and
 * `observe()` read that as a dead feed: one `data_stale` warn per quiet symbol, for a feed
 * that was answering fine.
 *
 * The one exception is a midpoint trading does not corroborate. Recency is the wrong tie-break
 * there, because the freshest thing about the book after the close is that it emptied: measured
 * 2026-08-26, CRM's last print was 205.75 at 19:59:55 and the book one minute LATER was
 * 208.90/213.94, so a 211.42 midpoint outranked a real trade on a stamp it earned by being
 * quoted into a vacuum. A stale real price beats a fresh imaginary one.
 *
 * Price and `asOf` travel together by construction. Stamping a trade price with the quote's
 * clock would leave the freshness gate measuring an age its value never had.
 */
function pickPrice(trade: Candidate | null, quote: Candidate | null): Candidate | null {
  if (!trade) return quote; // Unconfirmed or not, it is the only number there is.
  if (!quote) return trade;
  if (!quote.tradeConfirmed) return trade;
  return stamp(quote) > stamp(trade) ? quote : trade;
}

/** What a snapshot yields: a price, the clock it carries, and whether trading backs it. */
interface PriceHit {
  price: number;
  asOf: string;
  tradeConfirmed: boolean;
}

/**
 * `observe()` plus the third provenance axis.
 *
 * A thin wrapper rather than a fourth parameter on `observe()`, because `tradeConfirmed` is a
 * fact about PRICES and `observe()` is the chokepoint every observation in the system passes
 * through — see the field's own comment in `types.ts`.
 */
function observePrice(hit: PriceHit, source: SourceId, maxAgeMs: number): Observation<number> {
  return { ...observe(hit.price, source, hit.asOf, maxAgeMs), tradeConfirmed: hit.tradeConfirmed };
}


/**
 * Fetch latest prices for a batch of symbols from Alpaca snapshots.
 * Returns a map of symbol → { price, asOf } for every symbol that succeeded.
 * Throws if the HTTP call itself fails (caller decides fallback strategy).
 */
async function fetchAlpacaSnapshots(symbols: string[]): Promise<Map<string, PriceHit>> {
  const res = await alpacaData.get<Record<string, any>>('/v2/stocks/snapshots', {
    params: { symbols: symbols.join(','), feed: 'iex' },
  });

  const out = new Map<string, PriceHit>();
  for (const [symbol, snap] of Object.entries(res.data ?? {})) {
    // Last print, or the mid of the current bid/ask — whichever is more recent AND real.
    const pick = pickPrice(tradeCandidate(snap), quoteCandidate(snap));
    if (pick) {
      out.set(symbol, {
        price: pick.price,
        asOf: effectiveAsOf(pick.asOf),
        tradeConfirmed: pick.tradeConfirmed,
      });
    }
  }
  return out;
}

/** The high and low that actually TRADED over a window, with the coverage to judge it by. */
export interface TradedRange {
  high: number;
  low: number;
  /** Coverage: the caller cannot trust a range without knowing which window the bars spanned. */
  firstBarAt: string;
  lastBarAt: string;
  bars: number;
}

/**
 * What traded between two instants, from Alpaca's consolidated bars.
 *
 * The `sip` feed here against `iex` everywhere else above, on purpose. SIP is the whole tape,
 * and this account may query it historically but not live — a real-time snapshot returns
 * "403 subscription does not permit querying recent SIP data". Fifteen minutes' delay is
 * disqualifying for a price to trade on and irrelevant for a question about the past, which is
 * the only thing this function is for.
 *
 * The delay is enforced, not merely tolerated: an `end` inside the embargo makes the venue
 * refuse the WHOLE request, so asking for "up to now" returns a 403 rather than a slightly
 * short series. The window is therefore trimmed to where the data begins, and `lastBarAt` says
 * where it actually stopped so a caller can see the blind spot rather than infer none.
 *
 * Every bar is required to contain trades. That filter is the entire point: a bar with no
 * trades has extremes that nobody dealt at, which is the artifact being measured for.
 *
 * Five-minute bars because their extremes are still individual prints and the series reaches
 * back months, and because DAY bars cannot answer this at all — Alpaca's day bar covers the
 * regular session only, so CRM's post-earnings print at 236.00 on 2026-08-26, 14,047 trades in
 * five minutes, is absent from a day bar that stops at 206.44.
 *
 * The embargo length itself is `SIP_EMBARGO_MS`, shared from `core/alpacaHttp.ts` — the bar
 * collector hit the same 403 for the same reason, and one vendor limit must not be two numbers.
 */

export async function fetchTradedRange(
  symbol: string,
  from: Date,
  to: Date = new Date(),
): Promise<TradedRange> {
  const end = new Date(Math.min(to.getTime(), Date.now() - SIP_EMBARGO_MS));
  const bars: any[] = [];
  let pageToken: string | undefined;
  do {
    const res = await alpacaData.get<any>('/v2/stocks/bars', {
      params: {
        symbols: symbol,
        timeframe: '5Min',
        start: from.toISOString(),
        end: end.toISOString(),
        feed: 'sip',
        limit: 10000,
        page_token: pageToken,
      },
    });
    bars.push(...(res.data?.bars?.[symbol] ?? []));
    pageToken = res.data?.next_page_token ?? undefined;
  } while (pageToken);

  const traded = bars.filter((b) => b?.n > 0 && b?.h > 0 && b?.l > 0);
  if (traded.length === 0) {
    throw new Error(`${symbol}: no 5Min bars with trades between ${from.toISOString()} and ${end.toISOString()}`);
  }

  return {
    high: Math.max(...traded.map((b) => b.h)),
    low: Math.min(...traded.map((b) => b.l)),
    firstBarAt: traded[0].t,
    lastBarAt: traded[traded.length - 1].t,
    bars: traded.length,
  };
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
    if (hit) return observePrice(hit, ALPACA_SOURCE, maxAgeMs);
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
  let alpacaHits = new Map<string, PriceHit>();
  try {
    alpacaHits = await fetchAlpacaSnapshots(symbols);
  } catch {
    // Entire Alpaca call failed — all symbols fall through to Yahoo
  }

  for (const [symbol, hit] of alpacaHits) {
    result.set(symbol, observePrice(hit, ALPACA_SOURCE, maxAgeMs));
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
