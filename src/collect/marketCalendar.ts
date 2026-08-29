/**
 * L1 — the trading calendar.
 *
 * Exists for exactly one question: which session is the most recent one that has ALREADY
 * FINISHED? That is the session a daily bar series must contain in order to be current,
 * and it is not a question the clock can answer.
 *
 * `marketSession()` in `core/time.ts` is deliberately clock-only and therefore reports a
 * holiday as `open`. Its own comment argues that bias is the safe one, and for "is this
 * quote feed dead" it is. Here it is the unsafe one: a clock-only rule expects Thursday's
 * bar on the Friday after Thanksgiving, never gets one, and reports every symbol stale
 * through a real trading morning. Roughly nine days a year the system would refuse to
 * score anything.
 *
 * Alpaca's `/v2/calendar` knows both facts a clock cannot: which days hold no session at
 * all (2026-11-26 is simply absent from the response) and which close early (2026-11-27
 * returns `close: "13:00"`). Both measured.
 *
 * Cached because `collectBars` runs once per symbol, in parallel. The cache holds the
 * in-flight PROMISE rather than its resolved value: a value cache is still empty at the
 * moment N parallel collectors all miss it, so the first tick of each day would fire N
 * identical calendar requests.
 */

import { alpacaTrading } from '../core/alpacaHttp';
import { etNow } from '../core/time';

export interface TradingSession {
  /** ET calendar date, "YYYY-MM-DD". */
  date: string;
  /** ET wall time the session ends, "HH:MM" — "13:00" on a half day. */
  close: string;
}

/**
 * How far back to ask. Comfortably longer than the longest run of consecutive non-session
 * days the US market produces (a holiday adjoining a weekend), and short enough that the
 * answer stays one small response.
 */
const LOOKBACK_DAYS = 12;

let cached: { etDate: string; sessions: Promise<TradingSession[]> } | null = null;

function fetchSessions(todayEt: string): Promise<TradingSession[]> {
  const start = new Date(Date.parse(`${todayEt}T00:00:00Z`) - LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  return alpacaTrading
    .get<any[]>('/v2/calendar', { params: { start, end: todayEt } })
    .then((res) => {
      const sessions = (res.data ?? [])
        .filter((d) => typeof d?.date === 'string' && typeof d?.close === 'string')
        .map((d) => ({ date: d.date as string, close: d.close as string }))
        // Alpaca answers in ascending date order; sorting anyway is what lets the scan
        // below take the last element as the newest session rather than assume it.
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

      if (sessions.length === 0) {
        throw new Error(`/v2/calendar returned no usable sessions for ${start}..${todayEt}`);
      }
      return sessions;
    });
}

/** Sessions covering the last `LOOKBACK_DAYS`, at most one request per ET date. */
function sessions(now: Date): Promise<TradingSession[]> {
  const todayEt = etNow(now).date;
  if (cached?.etDate === todayEt) return cached.sessions;

  const pending = fetchSessions(todayEt);
  // A rejection must not become the cached answer for the rest of the day. Guarded on
  // identity so a later successful fetch is not evicted by an older failure settling late.
  pending.catch(() => {
    if (cached?.sessions === pending) cached = null;
  });

  cached = { etDate: todayEt, sessions: pending };
  return pending;
}

/**
 * The most recent session whose close has already passed.
 *
 * THROWS when the calendar is unreachable. The caller decides what an unknown calendar
 * means, because the one thing it must not silently mean is "everything is fresh".
 */
export async function lastCompletedSession(now: Date = new Date()): Promise<TradingSession> {
  const list = await sessions(now);
  const { date: todayEt, timeStr } = etNow(now);

  // Both sides are fixed-width and zero-padded ("2026-08-28", "16:00"), so lexical order
  // is chronological order and no date arithmetic is needed to compare them.
  for (let i = list.length - 1; i >= 0; i--) {
    const session = list[i];
    if (session.date < todayEt || (session.date === todayEt && timeStr >= session.close)) {
      return session;
    }
  }

  throw new Error(
    `no session closed on or before ${todayEt} ${timeStr} ET within the last ${LOOKBACK_DAYS} days`,
  );
}

/** Test/probe seam. Drops the cache so a probe can exercise the fetch more than once. */
export function resetCalendarCache(): void {
  cached = null;
}
