/**
 * L1 — OHLCV bars, provenance-stamped.
 *
 * Primary: Alpaca — `/v2/stocks/bars`, or `/v1beta3/crypto/us/bars` for a pair.
 * Fallback: Yahoo Finance, per symbol, when Alpaca fails.
 *
 * The same two-vendor shape as `priceSource.ts`, but the demotion of Yahoo to fallback was
 * forced by a measurement rather than chosen for symmetry. Yahoo serves the most recent
 * session's daily row with `close: null` and leaves it null after the close: measured
 * 2026-08-29 on AAPL, NVDA, SPY, XLE, AMD and TSLA, every one of them carried Friday's open,
 * high, low and volume with no close. A bar with no close is unusable and is dropped, so
 * every series silently ended a day early. Yahoo itself knew the number — AAPL's
 * `meta.regularMarketPrice` read 319.7 in the same response, matching Alpaca's 319.70 to the
 * cent — only its daily bar did not. Nothing about the shape of the response distinguishes
 * this from a genuinely absent session, which is why it is not patched over here.
 *
 * `asOf` is the timestamp of the LAST bar, so a series that stopped updating reads as stale
 * even though the HTTP call succeeded. That gate is the only thing standing between a
 * truncated series and an indicator computed on it, which is why the daily threshold below
 * is derived from the trading calendar rather than guessed in days.
 */

import type { Bar } from '../core/types';
import { alpacaData, alpacaTimeToMs, SIP_EMBARGO_MS } from '../core/alpacaHttp';
import { logger } from '../core/logger';
import { cryptoPair, isCryptoSymbol } from '../core/symbols';
import { lastCompletedSession } from './marketCalendar';
import { getBarsRaw, Timeframe } from './yahoo';
import { Maybe, missing, observe } from './types';

const ALPACA_SOURCE = 'alpaca' as const;
const YAHOO_SOURCE  = 'yahoo'  as const;

/**
 * Bars age by their own interval, not by the quote threshold — a daily series is not stale
 * at 90 seconds.
 *
 * The `1Day` entry is a FALLBACK, used only when the trading calendar cannot be reached.
 * Four days is what "tolerates a long weekend" actually costs: a series ending on Thursday
 * reads fresh all through Saturday, Sunday, Monday and most of Tuesday. That is how the
 * missing-Friday bug above went unreported for as long as it did — the data was a day short
 * and the freshness gate had no opinion about it. When the calendar is reachable,
 * `dailyMaxAgeMs` replaces this with the question actually worth asking.
 */
export const DEFAULT_MAX_BAR_AGE_MS: Record<Timeframe, number> = {
  '1Min': 5 * 60_000,
  '5Min': 15 * 60_000,
  '15Min': 45 * 60_000,
  '1Hour': 3 * 60 * 60_000,
  '1Day': 4 * 24 * 60 * 60_000,
};

/**
 * How much slop to allow either side of the session anchor.
 *
 * The daily threshold is really a date comparison — "does this series include the last
 * completed session?" — expressed as an age, so that `observe()` remains the single place in
 * L1 that decides what `stale` means. Anchoring on midnight UTC of the session date and
 * allowing half a day absorbs every bar-stamping convention in play without ever admitting a
 * bar from the session before: Alpaca stamps a daily equity bar at midnight ET (04:00Z in
 * summer, 05:00Z in winter), a crypto bar at 00:00Z, and Yahoo stamps the session OPEN at
 * 13:30Z. All four sit within twelve hours of the anchor, while the preceding session is
 * twenty or more hours outside it.
 */
const SESSION_ANCHOR_SLACK_MS = 12 * 60 * 60_000;

/**
 * Bars per trading day, used only to turn a bar count into a calendar-day lookback for
 * `start`. Deliberately loose: `sort: 'desc'` means the venue selects the newest `limit`
 * bars from whatever the window contains, so an over-wide window costs nothing while an
 * under-wide one silently shortens history.
 */
const BARS_PER_TRADING_DAY: Record<Timeframe, number> = {
  '1Min': 390,
  '5Min': 78,
  '15Min': 26,
  '1Hour': 7,
  '1Day': 1,
};

/**
 * The oldest bar the series may be missing and still count as current.
 *
 * For equities that is the last session the calendar says has closed. For crypto there is no
 * calendar to consult, so it is yesterday: a market that never closes should have produced
 * yesterday's bar by now, and anchoring on TODAY would flag a thin pair stale for the first
 * minutes after 00:00Z before its first trade of the day prints.
 */
async function dailyAnchorDate(symbol: string, now: Date): Promise<string> {
  if (isCryptoSymbol(symbol)) {
    return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  }
  return (await lastCompletedSession(now)).date;
}

async function dailyMaxAgeMs(symbol: string, now: Date): Promise<number> {
  try {
    const anchor = Date.parse(`${await dailyAnchorDate(symbol, now)}T00:00:00Z`);
    return now.getTime() - anchor + SESSION_ANCHOR_SLACK_MS;
  } catch (err) {
    // Louder than a silent widening, because the fallback is the threshold that hid a
    // missing session: from here on the gate cannot tell a day-short series from a current
    // one, and that is worth seeing in the log rather than inferring later.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `bar staleness: trading calendar unavailable (${message}) — falling back to the fixed ` +
      `4-day daily threshold, which cannot detect a series that is one session short`,
    );
    return DEFAULT_MAX_BAR_AGE_MS['1Day'];
  }
}

async function maxAgeFor(symbol: string, timeframe: Timeframe, now: Date): Promise<number> {
  return timeframe === '1Day'
    ? dailyMaxAgeMs(symbol, now)
    : DEFAULT_MAX_BAR_AGE_MS[timeframe];
}

function startFor(limit: number, timeframe: Timeframe, now: Date): string {
  const perDay = BARS_PER_TRADING_DAY[timeframe] ?? 1;
  // 7/5 for weekends, doubled for holidays and short sessions, +5 so a tiny limit still
  // spans one.
  const calendarDays = Math.ceil((limit / perDay) * (7 / 5) * 2) + 5;
  return new Date(now.getTime() - calendarDays * 86_400_000).toISOString();
}

/**
 * A bar needs all four prices to be a bar. Volume defaults to 0 because a session can
 * legitimately have none, while a missing close means the row describes nothing.
 *
 * Timestamps go through `alpacaTimeToMs` for the reason given where that lives: a
 * nanosecond stamp defeats bare `Date.parse`, and this one becomes the series' `asOf`, so an
 * unreadable stamp would make every symbol read stale. Unparseable values are passed through
 * untouched so `observe()` still sees a NaN age and calls it stale, rather than being handed
 * an invented fresh one.
 */
function toBars(raw: any[]): Bar[] {
  return raw
    .filter((b) =>
      [b?.o, b?.h, b?.l, b?.c].every((n) => typeof n === 'number' && Number.isFinite(n)),
    )
    .map((b) => {
      const ms = alpacaTimeToMs(String(b.t));
      return {
        t: Number.isFinite(ms) ? new Date(ms).toISOString() : String(b.t),
        o: b.o,
        h: b.h,
        l: b.l,
        c: b.c,
        v: typeof b.v === 'number' ? b.v : 0,
      };
    });
}

/**
 * The newest `limit` bars from Alpaca. THROWS on failure and on an empty series, so the
 * caller can preserve the error as provenance.
 *
 * `sort: 'desc'` with `limit` is what makes this one request instead of a paginated loop.
 * Alpaca applies `limit` from the START of the range, so an ascending request for 60 bars
 * across a 90-day window returns the OLDEST 60 — the opposite of what every caller wants.
 * Descending returns exactly the newest N, which also frees `start` to be as loose as it
 * likes. Reversed back to ascending before returning, because indicators and correlations
 * all read oldest-first.
 *
 * `start` is not optional in practice: `limit` alone returns `{"bars":{}}` (measured).
 *
 * `feed` is deliberately UNSET. Leaving it to the subscription yields the full consolidated
 * tape wherever the account is entitled to it — AAPL's 2026-08-28 volume was 38.85M on sip
 * against 1.08M on iex, under 3% of the tape, with the close 12 cents adrift — and iex where
 * it is not. Pinning `sip` would 403 an unentitled account straight into the Yahoo fallback,
 * which is the very source this function exists in order to stop depending on.
 *
 * `end` is held back by `SIP_EMBARGO_MS` because a sip-entitled account is refused outright
 * for asking about the recent past. Sixteen minutes is immaterial to a daily bar and is the
 * difference between a series and a 403.
 */
async function fetchAlpacaBars(
  symbol: string,
  limit: number,
  timeframe: Timeframe,
  now: Date,
): Promise<Bar[]> {
  const crypto = isCryptoSymbol(symbol);
  const wireSymbol = crypto ? cryptoPair(symbol) : symbol.toUpperCase();

  const params: Record<string, unknown> = {
    symbols: wireSymbol,
    timeframe,
    limit,
    sort: 'desc',
    start: startFor(limit, timeframe, now),
  };
  // Crypto trades on Alpaca's own book: one feed, no entitlement tiers, no embargo.
  if (!crypto) {
    params.end = new Date(now.getTime() - SIP_EMBARGO_MS).toISOString();
  }

  const res = await alpacaData.get<any>(
    crypto ? '/v1beta3/crypto/us/bars' : '/v2/stocks/bars',
    { params },
  );

  const bars = toBars(res.data?.bars?.[wireSymbol] ?? []).reverse();
  if (bars.length === 0) {
    throw new Error(`${symbol}: alpaca returned no usable ${timeframe} bars`);
  }
  return bars;
}

/**
 * Bars for one symbol, Alpaca first and Yahoo second.
 *
 * `maxAgeMs` left undefined means "work it out" — for a daily series that is a calendar
 * question, and a caller that hard-coded a number would be answering it wrongly. Passing one
 * explicitly still overrides, which is what the replay harness and any deliberate widening
 * need.
 */
export async function collectBars(
  symbol: string,
  limit = 60,
  timeframe: Timeframe = '1Day',
  maxAgeMs?: number,
): Promise<Maybe<Bar[]>> {
  const now = new Date();
  const threshold = maxAgeMs ?? (await maxAgeFor(symbol, timeframe, now));

  let alpacaError: unknown;
  try {
    const bars = await fetchAlpacaBars(symbol, limit, timeframe, now);
    return observe(bars, ALPACA_SOURCE, bars[bars.length - 1].t, threshold);
  } catch (err) {
    alpacaError = err;
  }

  try {
    const bars = await getBarsRaw(symbol, limit, timeframe);
    return observe(bars, YAHOO_SOURCE, bars[bars.length - 1].t, threshold);
  } catch (yahooError) {
    // Attributed to Alpaca because that is the source that was supposed to answer, but both
    // messages are kept: "Alpaca refused the symbol and so did Yahoo" is a different problem
    // from "Alpaca is down", and one string that hid the other would make them look alike.
    const primary = alpacaError instanceof Error ? alpacaError.message : String(alpacaError);
    const secondary = yahooError instanceof Error ? yahooError.message : String(yahooError);
    return missing(ALPACA_SOURCE, `alpaca: ${primary}; yahoo fallback: ${secondary}`);
  }
}
