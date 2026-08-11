/**
 * ET (America/New_York) time utilities.
 * Uses Intl.DateTimeFormat so DST transitions are handled correctly.
 */

export interface ETComponents {
  day: number;     // 0=Sun … 6=Sat
  hours: number;   // 0–23
  minutes: number; // 0–59
  timeStr: string; // "HH:MM"
  date: string;    // "YYYY-MM-DD" in ET
}

const DAY_MAP: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export function etNow(now: Date = new Date()): ETComponents {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const hours = parseInt(p.hour, 10) % 24; // guard against "24" at midnight
  const minutes = parseInt(p.minute, 10);

  return {
    day: DAY_MAP[p.weekday] ?? 1,
    hours,
    minutes,
    timeStr: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

/**
 * Today's trading date in ET.
 *
 * Everything day-scoped — the daily loss baseline, daily dedup — must key off this and
 * never off `toISOString().slice(0, 10)`. UTC rolls over at 19:00 or 20:00 ET, i.e. in the
 * middle of the after-hours session and hours before the next open: a UTC-keyed daily
 * reset re-baselines the loss limit while the same trading day is still running.
 */
export function etDate(now: Date = new Date()): string {
  return etNow(now).date;
}

export type MarketSession = 'closed' | 'premarket' | 'open' | 'afterhours';

/**
 * Which trading session an instant falls in, from the clock alone.
 *
 * Exists so detectors can tell a dead feed from a closed market. `maxQuoteAgeMs` is a
 * market-hours rule; applied around the clock it turns every overnight into a stale-data
 * storm, one event per watched symbol.
 *
 * Deliberately clock-only, not `broker.isMarketOpen()`: that is a network call per 60s tick,
 * is unknown on failure, and would make `snapshotFrom` async — breaking the replay harness's
 * virtual clock. The cost is holidays and half-days, which this reports as `open`. That bias
 * is the safe one: a false `open` fires a burst of events once and the cooldown absorbs it,
 * while a false `closed` would suppress a real feed outage during live trading.
 */
export function marketSession(now: Date = new Date()): MarketSession {
  const { day, hours, minutes } = etNow(now);
  if (day === 0 || day === 6) return 'closed';

  const etMinutes = hours * 60 + minutes;
  if (etMinutes < 240) return 'closed';       // before 04:00
  if (etMinutes < 570) return 'premarket';    // 04:00–09:29
  if (etMinutes < 960) return 'open';         // 09:30–15:59
  if (etMinutes < 1200) return 'afterhours';  // 16:00–19:59
  return 'closed';                            // 20:00 onward
}
