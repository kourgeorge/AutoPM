/**
 * L1 — fundamentals and the earnings calendar.
 *
 * One `quoteSummary` call per symbol produces one cache entry that serves two tools:
 * `get_calendar` (dates and surprise history) and `get_fundamentals` (crowding, liquidity,
 * balance sheet, revisions). They are built together because they are the same fetch; splitting
 * them into two modules would mean two calls and two TTLs over one payload.
 *
 * *Deviation from the roadmap, deliberate:* P5 (`roadmap.md:588`) names `data/calendar.json`.
 * The file here is `data/fundamentals.json` because the cached unit is the whole payload, not
 * the dates alone.
 *
 * Two readers, the `sectorCache.ts` split:
 *  - `getFundamentals` may hit Yahoo, so it belongs to on-demand paths (the two tools, the
 *    trader context builder) where one HTTP call per stale symbol is affordable.
 *  - `getCachedFundamentals` is PURE — no network, no promise — for any path that must not
 *    block on Yahoo. A miss there is `null` until an on-demand path warms it.
 *
 * TTL, unlike `sectorCache`'s (which has none, because a sector does not change): 24 hours, AND
 * early expiry the moment `nextEarningsAt` passes. Age alone is the wrong test — a print makes
 * the cached date wrong immediately and the statements behind it are about to be restated.
 *
 * What is cached: any call that SUCCEEDED, including one that came back with modules missing
 * ("XLE has no `calendarEvents`" is a durable fact about XLE). Never a throw. This is sharper
 * than `sectorCache`'s never-cache-nulls rule, and can be, because `getFundamentalsRaw` throws
 * where `getSectorRaw` swallows: here a failure and an empty answer are distinguishable.
 */

import fs from 'fs';
import path from 'path';
import { writeFileAtomic } from '../core/fsAtomic';
import { logger } from '../core/logger';
import { DATA_DIR, ensureDataDir } from '../core/paths';
import { getFundamentalsRaw, FUNDAMENTAL_MODULES } from './yahoo';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EarningsSurprise {
  /** Quarter end, ISO date. */
  quarter: string | null;
  epsActual: number | null;
  epsEstimate: number | null;
  /** Percent, normalised from Yahoo's fraction. */
  surprisePct: number | null;
}

export interface CalendarFacts {
  /** Earliest earnings date still in the future, ISO. `null` = none scheduled that Yahoo knows. */
  nextEarningsAt: string | null;
  /**
   * Whole days from now, floored. `0` means less than 24 hours away — which includes a print
   * today after the close.
   */
  daysUntil: number | null;
  /** `true` confirmed-not, `false` confirmed, `null` Yahoo did not say. */
  isEstimate: boolean | null;
  /** Both ends when Yahoo reports more than one candidate date. One print, not two. */
  earningsWindow: [string, string] | null;
  exDividendDate: string | null;
  dividendDate: string | null;
  /** Oldest quarter first, as Yahoo returns it. */
  surpriseHistory: EarningsSurprise[];
}

export interface RevisionFacts {
  period: string;
  upLast30days: number | null;
  downLast30days: number | null;
  upLast7days: number | null;
  downLast7days: number | null;
  /** Percent, normalised from Yahoo's fraction. */
  growthPct: number | null;
}

export interface Fundamentals {
  symbol: string;
  calendar: CalendarFacts;
  crowding: {
    shortPctOfFloat: number | null;
    sharesShort: number | null;
    sharesShortPriorMonth: number | null;
    /** Short interest is published roughly biweekly, so this is routinely days old. */
    shortInterestAsOf: string | null;
    floatShares: number | null;
    heldPctInstitutions: number | null;
    heldPctInsiders: number | null;
    beta: number | null;
  };
  liquidity: {
    marketCap: number | null;
    avgVolume10Day: number | null;
    avgVolume: number | null;
    fiftyTwoWeekHigh: number | null;
    fiftyTwoWeekLow: number | null;
  };
  balanceSheet: {
    totalCash: number | null;
    totalDebt: number | null;
    /** ALREADY a percentage in Yahoo's payload — not multiplied here. */
    debtToEquityPct: number | null;
    currentRatio: number | null;
    profitMarginsPct: number | null;
    revenueGrowthPct: number | null;
    earningsGrowthPct: number | null;
    freeCashflow: number | null;
  };
  revisions: {
    currentQuarter: RevisionFacts | null;
    currentYear: RevisionFacts | null;
  };
  /** Which requested modules Yahoo actually returned. An absent module is a fact, not an error. */
  modulesPresent: string[];
  source: 'yahoo';
  /** Facts about the data, never advice — the `Exposure.caveats` contract. */
  caveats: string[];
}

// ── Mapping ───────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A number, or `null`. Never `0` for a missing field.
 *
 * The `.raw` unwrap is insurance against shape drift: this version of the API returns plain
 * numbers (measured), but older responses wrapped every figure as `{ raw, fmt, longFmt }`.
 */
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v !== null && typeof v === 'object' && 'raw' in (v as any)) return num((v as any).raw);
  return null;
}

/** Round to `dp`, killing the float noise Yahoo ships (`0.0123000005`, `0.040999997`). */
function round(v: number | null, dp = 2): number | null {
  return v === null ? null : parseFloat(v.toFixed(dp));
}

/** Fraction → percent. Applied per FIELD, never per module: `debtToEquity` is already percent. */
function pct(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : round(n * 100);
}

/** Yahoo dates arrive as `Date` at runtime and as an ISO string out of the cache file. */
function toIso(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'number') return new Date(v * 1000).toISOString();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

function daysUntilFrom(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((t - now) / DAY_MS);
}

function ageDays(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / DAY_MS);
}

function mapRevision(entry: any): RevisionFacts | null {
  if (entry == null) return null;
  const rev = entry.epsRevisions ?? {};
  return {
    period: String(entry.period ?? '?'),
    upLast30days:   num(rev.upLast30days),
    downLast30days: num(rev.downLast30days),
    upLast7days:    num(rev.upLast7days),
    // `downLast7Days` with a capital D — Yahoo's own inconsistency, both spellings observed.
    downLast7days:  num(rev.downLast7days ?? rev.downLast7Days),
    growthPct:      pct(entry.growth),
  };
}

/**
 * PURE. No network, no clock beyond `now`, no writes. All unit normalisation and all caveat
 * generation live here, which makes this the one seam worth probing.
 */
export function mapFundamentals(
  symbol: string,
  raw: any,
  modulesPresent: string[],
  now: number = Date.now(),
): Fundamentals {
  const caveats: string[] = [];

  const ks   = raw?.defaultKeyStatistics ?? {};
  const sd   = raw?.summaryDetail ?? {};
  const fd   = raw?.financialData ?? {};
  const cal  = raw?.calendarEvents ?? {};
  const hist = raw?.earningsHistory?.history ?? [];
  const trend = raw?.earningsTrend?.trend ?? [];

  // An absent module means the field is unknown, and WHICH module is absent tells the reader
  // which fields to stop looking for. A blanket "no data" would be false: XLE returns real
  // volume and a real 52-week range while having no earnings at all.
  const absent = FUNDAMENTAL_MODULES.filter(m => !modulesPresent.includes(m));
  const ABSENT_CONSEQUENCE: Record<string, string> = {
    calendarEvents:       'no earnings or dividend date is reported for this symbol (normal for an ETF)',
    earningsHistory:      'no surprise history',
    earningsTrend:        'estimate revisions unknown',
    financialData:        'margins, growth and balance sheet unknown',
    defaultKeyStatistics: 'crowding, float and beta unknown',
    summaryDetail:        'market cap, volume and 52-week range unknown',
  };
  for (const m of absent) {
    caveats.push(`${m} module absent — ${ABSENT_CONSEQUENCE[m] ?? 'those fields unknown'}`);
  }

  // ── Earnings dates ──
  // `earningsDate` is an ARRAY. Two entries are one unconfirmed print somewhere in a window,
  // not two prints.
  const rawDates: string[] = (Array.isArray(cal?.earnings?.earningsDate)
    ? cal.earnings.earningsDate
    : [])
    .map(toIso)
    .filter((d: string | null): d is string => d !== null)
    .sort();

  const future = rawDates.filter(d => Date.parse(d) >= now);
  const nextEarningsAt = future[0] ?? null;

  let earningsWindow: [string, string] | null = null;
  if (future.length >= 2 && future[0] !== future[future.length - 1]) {
    earningsWindow = [future[0], future[future.length - 1]];
    caveats.push(
      `${future.length} candidate earnings dates (${future[0].slice(0, 10)} to ` +
      `${future[future.length - 1].slice(0, 10)}) — the print is somewhere in that window, not on every day in it`,
    );
  }

  if (nextEarningsAt === null && rawDates.length > 0) {
    caveats.push(
      `the only earnings date reported (${rawDates[rawDates.length - 1].slice(0, 10)}) is in the ` +
      `past — the next print is not yet scheduled`,
    );
  }

  const estFlag = cal?.earnings?.isEarningsDateEstimate;
  const isEstimate = typeof estFlag === 'boolean' ? estFlag : null;
  if (isEstimate === true) {
    caveats.push('earnings date is an estimate, not confirmed — treat the day either side as in scope');
  } else if (isEstimate === null && nextEarningsAt !== null) {
    caveats.push('yahoo did not say whether the earnings date is confirmed or estimated');
  }

  const surpriseHistory: EarningsSurprise[] = (Array.isArray(hist) ? hist : []).map((h: any) => ({
    quarter:     toIso(h?.quarter),
    epsActual:   num(h?.epsActual),
    epsEstimate: num(h?.epsEstimate),
    surprisePct: pct(h?.surprisePercent),
  }));

  // ── Crowding ──
  const shortInterestAsOf = toIso(ks?.dateShortInterest);
  const siAge = ageDays(shortInterestAsOf, now);
  if (shortInterestAsOf && siAge !== null && siAge > 0) {
    caveats.push(
      `short interest as of ${shortInterestAsOf.slice(0, 10)}, ${siAge} day(s) old — ` +
      `crowding may have changed since`,
    );
  }

  const trendFor = (period: string) =>
    (Array.isArray(trend) ? trend : []).find((t: any) => t?.period === period) ?? null;

  return {
    symbol,
    calendar: {
      nextEarningsAt,
      daysUntil: daysUntilFrom(nextEarningsAt, now),
      isEstimate,
      earningsWindow,
      exDividendDate: toIso(cal?.exDividendDate),
      dividendDate:   toIso(cal?.dividendDate),
      surpriseHistory,
    },
    crowding: {
      shortPctOfFloat:       pct(ks?.shortPercentOfFloat),
      sharesShort:           num(ks?.sharesShort),
      sharesShortPriorMonth: num(ks?.sharesShortPriorMonth),
      shortInterestAsOf,
      floatShares:           num(ks?.floatShares),
      heldPctInstitutions:   pct(ks?.heldPercentInstitutions),
      heldPctInsiders:       pct(ks?.heldPercentInsiders),
      // Beta lives in both modules and is absent from `defaultKeyStatistics` for funds.
      beta:                  round(num(ks?.beta) ?? num(sd?.beta)),
    },
    liquidity: {
      marketCap:         num(sd?.marketCap) ?? num(ks?.totalAssets),
      avgVolume10Day:    num(sd?.averageDailyVolume10Day),
      avgVolume:         num(sd?.averageVolume),
      fiftyTwoWeekHigh:  num(sd?.fiftyTwoWeekHigh),
      fiftyTwoWeekLow:   num(sd?.fiftyTwoWeekLow),
    },
    balanceSheet: {
      totalCash:         num(fd?.totalCash),
      totalDebt:         num(fd?.totalDebt),
      // NOT multiplied: Yahoo already reports this as a percentage (NVDA 6.555 = 6.6%).
      debtToEquityPct:   round(num(fd?.debtToEquity)),
      currentRatio:      round(num(fd?.currentRatio)),
      profitMarginsPct:  pct(fd?.profitMargins),
      revenueGrowthPct:  pct(fd?.revenueGrowth),
      earningsGrowthPct: pct(fd?.earningsGrowth),
      freeCashflow:      num(fd?.freeCashflow),
    },
    revisions: {
      currentQuarter: mapRevision(trendFor('0q')),
      currentYear:    mapRevision(trendFor('0y')),
    },
    modulesPresent,
    source: 'yahoo',
    caveats,
  };
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const FUNDAMENTALS_FILE = path.join(DATA_DIR, 'fundamentals.json');
const TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  fetchedAt: string;
  mapped: Fundamentals;
}

/** Loaded once on first read, then authoritative in memory. */
let _cache: Record<string, CacheEntry> | null = null;

/** One spelling per entry, so `nvda` and `NVDA` cannot both occupy the file. */
function key(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function load(): Record<string, CacheEntry> {
  if (_cache) return _cache;
  let loaded: Record<string, CacheEntry> = {};
  try {
    if (fs.existsSync(FUNDAMENTALS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(FUNDAMENTALS_FILE, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) loaded = parsed;
    }
  } catch (err: any) {
    logger.warn(`[Fundamentals] Unreadable cache — starting empty: ${err.message}`);
  }
  return (_cache = loaded);
}

/**
 * Synchronous, like the journal's and the sector cache's: a cache is worthless if the process
 * dies with the write still in a timer, and repeating a Yahoo call is the cost of getting it
 * wrong. A write failure logs and continues — this must never take down a trading cycle.
 */
function save(): void {
  try {
    ensureDataDir();
    writeFileAtomic(FUNDAMENTALS_FILE, JSON.stringify(_cache, null, 2));
  } catch (err: any) {
    logger.warn(`[Fundamentals] Write failed — in-memory cache still valid: ${err.message}`);
  }
}

/**
 * Two independent reasons an entry is stale, and the second is the point of having it:
 *  - older than a day, or
 *  - its `nextEarningsAt` has passed. The instant a company reports, the cached date is wrong
 *    and the statements behind it are about to be restated. A fresh `fetchedAt` does not save it.
 */
function isStale(entry: CacheEntry, now: number): boolean {
  const fetched = Date.parse(entry.fetchedAt);
  if (Number.isNaN(fetched) || now - fetched > TTL_MS) return true;
  const next = entry.mapped?.calendar?.nextEarningsAt;
  if (next && Date.parse(next) < now) return true;
  return false;
}

/**
 * `daysUntil` is computed, never trusted from the file: a cached one is wrong within hours,
 * and a stale countdown next to a fresh date is worse than no countdown.
 */
function withFreshCountdown(mapped: Fundamentals, now: number): Fundamentals {
  return {
    ...mapped,
    calendar: { ...mapped.calendar, daysUntil: daysUntilFrom(mapped.calendar.nextEarningsAt, now) },
  };
}

/**
 * Cache-only lookup. Pure: no network, no writes, safe anywhere.
 * Symbols never fetched — or whose entry has gone stale — read as `null`.
 */
export function getCachedFundamentals(
  symbols: string[],
  now: number = Date.now(),
): Record<string, Fundamentals | null> {
  const cache = load();
  const out: Record<string, Fundamentals | null> = {};
  for (const s of symbols) {
    const entry = cache[key(s)];
    out[s] = entry && !isStale(entry, now) ? withFreshCountdown(entry.mapped, now) : null;
  }
  return out;
}

/**
 * Resolve fundamentals for one symbol, fetching only when the cache has nothing fresh.
 * Throws what the fetch threw — the caller decides what a failure means, and NOTHING is
 * written on that path, so a network blip can never freeze into a permanent "unknown".
 */
export async function getFundamentals(symbol: string): Promise<Fundamentals> {
  const now = Date.now();
  const k = key(symbol);
  const cache = load();

  const entry = cache[k];
  if (entry && !isStale(entry, now)) return withFreshCountdown(entry.mapped, now);

  const { raw, modulesPresent } = await getFundamentalsRaw(k);
  const mapped = mapFundamentals(k, raw, modulesPresent, now);

  cache[k] = { fetchedAt: new Date(now).toISOString(), mapped };
  save();
  return mapped;
}

/**
 * Resolve many, one fetch per stale symbol and never a fetch inside a caller's loop — the
 * `getSectors` precedent and the O(n)-fetches invariant in `src/strategy/exposure.ts`.
 *
 * A symbol whose fetch throws resolves to `null` here rather than taking the batch down: this
 * feeds the cycle context, where one unreachable symbol must not cost the other rows.
 */
export async function getFundamentalsBatch(
  symbols: string[],
): Promise<Record<string, Fundamentals | null>> {
  const unique = [...new Set(symbols.map(key))];
  const results = await Promise.all(
    unique.map(async s => {
      try {
        return { symbol: s, value: await getFundamentals(s) };
      } catch {
        return { symbol: s, value: null as Fundamentals | null };
      }
    }),
  );

  const byKey = new Map(results.map(r => [r.symbol, r.value]));
  const out: Record<string, Fundamentals | null> = {};
  for (const s of symbols) out[s] = byKey.get(key(s)) ?? null;
  return out;
}
