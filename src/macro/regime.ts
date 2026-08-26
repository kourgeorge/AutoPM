/**
 * Macro Regime Classification Service.
 *
 * Fetches key economic indicators from FRED and classifies the current macro
 * environment into one of four regimes: expansion, late-cycle, recession, recovery.
 *
 * The regime signal conditions downstream trading decisions: the trader agent
 * can tighten entry criteria in late-cycle/recession and loosen them in expansion.
 *
 * Inspired by Ang, Azimbayev & Kim (2026) "The Self-Driving Portfolio" — their
 * macro agent scores growth, inflation, monetary policy, and financial conditions
 * to produce a regime label that all downstream agents consume.
 *
 * ─── POSSIBLE FUTURE EXPANSIONS ───
 * - Add monetary policy dimension (Fed Funds rate trajectory, yield curve inversion depth)
 * - Add credit conditions (high-yield spreads via BAMLH0A0HYM2)
 * - Add labor market breadth (initial claims trend via ICSA)
 * - Add consumer confidence (UMCSENT)
 * - Weight dimensions and produce a continuous regime score (0-1) instead of a label
 * - Add regime transition probabilities using a Markov model on historical data
 * - Cache regime across ticks (it changes slowly) and only refresh every few hours
 * - Add a "confidence" field indicating how clearly the data points to one regime
 */

import axios from 'axios';
import { logger } from '../core/logger';

const FRED_API_KEY = process.env.FRED_API_KEY ?? '';
const FRED_BASE_URL = 'https://api.stlouisfed.org/fred/series/observations';

// ── Types ────────────────────────────────────────────────────────────────────

export type Regime = 'expansion' | 'late_cycle' | 'recession' | 'recovery';

export interface RegimeClassification {
  regime: Regime;
  confidence: 'high' | 'medium' | 'low';
  scores: {
    growth: number;      // -1 (contracting) to +1 (expanding strongly)
    inflation: number;   // 0 (low) to 1 (hot)
    financial: number;   // -1 (stressed) to +1 (loose)
  };
  indicators: {
    gdpGrowth: number | null;        // Real GDP annualized QoQ %
    unemployment: number | null;     // Unemployment rate %
    /**
     * `T10YIE` — the 10-year BREAKEVEN inflation rate: what the bond market expects
     * inflation to average over ten years. It is NOT realised CPI, and was labelled `cpi`
     * for long enough to be worth naming loudly: the two disagree most exactly when
     * inflation is turning, which is when a regime label matters.
     */
    inflationExpectation: number | null;
    yieldSpread10y2y: number | null; // 10Y-2Y spread (negative = inverted)
    vix: number | null;              // VIX level
  };
  /** How many of `indicatorsTotal` FRED series produced a usable value this fetch. */
  indicatorsMeasured: number;
  indicatorsTotal: number;
  /**
   * Facts about the DATA behind this classification — a missing series, an absent key —
   * never advice about what to do with it. Same contract as `metrics.ts`: code measures,
   * the LLM interprets. Empty on a complete read.
   */
  caveats: string[];
  fetchedAt: string;
  source: string;
}

// ── FRED fetcher ─────────────────────────────────────────────────────────────

/**
 * One indicator's outcome. `value: null` alone was ambiguous in the way that matters here:
 * a series FRED answered with nothing usable and a series FRED never answered are the same
 * `null` downstream, and only the second one is worth retrying. The TTL below reads `failed`,
 * so keeping them apart is what stops a permanently-blank series from re-fetching all six
 * indicators every five minutes forever.
 */
interface SeriesResult {
  value: number | null;
  failed: boolean;
}

/**
 * FRED answers a bad key or an unknown series id with a 4xx, and retrying that is pure
 * waste. A 5xx, a 429, or no response at all is the gateway having a moment, and the next
 * attempt usually lands: the 502 that cost us the GDP indicator on 2026-08-26 answered 200
 * six times running a few minutes later.
 */
function isTransient(err: any): boolean {
  const status = err?.response?.status;
  if (status == null) return true; // timeout, DNS, socket — no answer to trust either way
  return status >= 500 || status === 429;
}

/**
 * One retry, not three. `applyRegimeSizing` calls `getRegime` on the order path, so this
 * timeout is time an entry can sit waiting; the retry gets the shorter budget to keep the
 * worst case near 15s per series rather than a multiple of the first attempt's 10s. The six
 * series are fetched in parallel, so that is the batch's worst case too, not six times it.
 */
const FIRST_TIMEOUT_MS = 10_000;
const RETRY_TIMEOUT_MS = 5_000;
const RETRY_BACKOFF_MS = 400;

async function fetchFredSeries(seriesId: string, limit = 5): Promise<SeriesResult> {
  if (!FRED_API_KEY) {
    logger.warn(`[Regime] FRED_API_KEY not set, cannot fetch ${seriesId}`);
    // Not `failed`: no key is a permanent condition, and the short retry TTL exists for
    // conditions that can heal. The `source: 'fallback'` label already says this happened.
    return { value: null, failed: false };
  }

  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const res = await axios.get(FRED_BASE_URL, {
        params: {
          series_id: seriesId,
          api_key: FRED_API_KEY,
          file_type: 'json',
          limit,
          sort_order: 'desc',
        },
        timeout: attempt === 0 ? FIRST_TIMEOUT_MS : RETRY_TIMEOUT_MS,
      });

      const observations = res.data?.observations ?? [];
      for (const obs of observations) {
        if (obs.value != null && obs.value !== '.') {
          return { value: parseFloat(obs.value), failed: false };
        }
      }
      // FRED answered. Every recent observation is a placeholder, which is a fact about the
      // series, not a fault — retrying returns the same placeholders.
      return { value: null, failed: false };
    } catch (err: any) {
      const retryable = isTransient(err) && attempt === 0;
      logger.error(
        `[Regime] Failed to fetch FRED series ${seriesId}: ${err.message}` +
          (retryable ? ` — retrying once in ${RETRY_BACKOFF_MS}ms` : ''),
      );
      if (!retryable) return { value: null, failed: true };
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    }
  }

  return { value: null, failed: true };
}

// ── Scoring functions ────────────────────────────────────────────────────────

function scoreGrowth(gdp: number | null, unemployment: number | null): number {
  // GDP: >3% = strong expansion (+1), 1-3% = moderate (+0.5), 0-1% = stalling (0),
  //       negative = contraction (-0.5 to -1)
  let gdpScore = 0;
  if (gdp !== null) {
    if (gdp > 3) gdpScore = 1;
    else if (gdp > 1) gdpScore = 0.5;
    else if (gdp > 0) gdpScore = 0;
    else if (gdp > -2) gdpScore = -0.5;
    else gdpScore = -1;
  }

  // Unemployment: <4% = tight labor (+0.5), 4-5% = neutral (0), >5% = weak (-0.5), >7% = severe (-1)
  let unempScore = 0;
  if (unemployment !== null) {
    if (unemployment < 4) unempScore = 0.5;
    else if (unemployment < 5) unempScore = 0;
    else if (unemployment < 7) unempScore = -0.5;
    else unempScore = -1;
  }

  // Average available scores
  const parts = [gdp !== null ? gdpScore : null, unemployment !== null ? unempScore : null].filter(
    (x): x is number => x !== null,
  );
  return parts.length > 0 ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
}

/**
 * Thresholds are the familiar CPI ones, applied to the 10-year breakeven. Deliberate: the
 * bands say "is inflation a problem for a risk asset", and the market's ten-year answer is
 * the more forward-looking input for a regime label. Worth knowing that a breakeven is far
 * less volatile than realised CPI, so this score moves less than the band names suggest —
 * >5% is a regime break, not a hot print.
 */
function scoreInflation(breakeven: number | null): number {
  if (breakeven === null) return 0.5; // assume moderate if unknown
  if (breakeven < 2) return 0.1;
  if (breakeven < 3) return 0.3;
  if (breakeven < 5) return 0.6;
  return 1.0;
}

function scoreFinancial(yieldSpread: number | null, vix: number | null): number {
  // Yield spread: >1% = healthy (+0.5), 0-1% = flattening (0), <0 = inverted (-0.5 to -1)
  let spreadScore = 0;
  if (yieldSpread !== null) {
    if (yieldSpread > 1) spreadScore = 0.5;
    else if (yieldSpread > 0) spreadScore = 0;
    else if (yieldSpread > -0.5) spreadScore = -0.5;
    else spreadScore = -1;
  }

  // VIX: <15 = complacent (+0.5), 15-20 = normal (0.2), 20-30 = elevated (-0.3), >30 = stressed (-0.8)
  let vixScore = 0;
  if (vix !== null) {
    if (vix < 15) vixScore = 0.5;
    else if (vix < 20) vixScore = 0.2;
    else if (vix < 30) vixScore = -0.3;
    else vixScore = -0.8;
  }

  const parts = [yieldSpread !== null ? spreadScore : null, vix !== null ? vixScore : null].filter(
    (x): x is number => x !== null,
  );
  return parts.length > 0 ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
}

// ── Regime classification ────────────────────────────────────────────────────

function classifyRegime(
  growth: number,
  inflation: number,
  financial: number,
): { regime: Regime; confidence: 'high' | 'medium' | 'low' } {
  // Decision tree:
  // - Recession: growth strongly negative AND financial stressed
  // - Recovery:  growth improving from negative, financial improving
  // - Late cycle: growth positive but inflation high OR financial tightening
  // - Expansion: growth positive, inflation moderate, financial loose

  if (growth <= -0.3 && financial <= -0.3) {
    const confidence = growth <= -0.7 ? 'high' : 'medium';
    return { regime: 'recession', confidence };
  }

  if (growth > -0.3 && growth <= 0.2 && financial > -0.3) {
    // Modest growth, not stressed — could be early recovery
    return { regime: 'recovery', confidence: 'medium' };
  }

  if (growth > 0.2 && (inflation >= 0.6 || financial <= 0)) {
    // Growth positive but inflation hot or financial tightening = late cycle
    const confidence = inflation >= 0.8 || financial <= -0.3 ? 'high' : 'medium';
    return { regime: 'late_cycle', confidence };
  }

  if (growth > 0.2 && inflation < 0.6 && financial > 0) {
    const confidence = growth >= 0.7 ? 'high' : 'medium';
    return { regime: 'expansion', confidence };
  }

  // Ambiguous — default to late_cycle with low confidence
  return { regime: 'late_cycle', confidence: 'low' };
}

// ── Cache ────────────────────────────────────────────────────────────────────

let _cache: RegimeClassification | null = null;
/** When the entry in `_cache` stops being usable. One variable: the age and the TTL it was
 *  compared against were only ever read together, in one expression. */
let _cacheExpiresAt: number = 0;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — regime changes slowly
/**
 * A classification drawn from a DEGRADED fetch — no indicators, or merely some of them — is
 * cached only this long. The 6-hour TTL is justified by the regime changing slowly; a fetch
 * failure does not change slowly, and pinning the result for six hours turned one FRED
 * outage into a whole session of it. Measured 2026-08-26: a single 502 on `A191RL1Q225SBEA`
 * dropped `growth` from 0.25 to 0.00, which is the boundary between `expansion` and
 * `recovery` at `classifyRegime`'s `growth > 0.2` gate.
 *
 * Applies to a TRANSIENT failure only. A missing `FRED_API_KEY` cannot heal — `fetchFredSeries`
 * short-circuits before the network — so retrying it every 5 minutes buys nothing and costs six
 * no-op calls and seven log lines each time, ~78 refreshes a day instead of 2. Worse, one of
 * `getRegime`'s callers is `applyRegimeSizing` on the order path, where a refresh that does
 * reach the network can hold an entry for up to 10s per indicator.
 */
const NO_DATA_TTL_MS = 5 * 60 * 1000;

// ── Public API ───────────────────────────────────────────────────────────────

export async function getRegime(forceRefresh = false): Promise<RegimeClassification> {
  const now = Date.now();
  if (!forceRefresh && _cache && now < _cacheExpiresAt) {
    return _cache;
  }

  logger.info('[Regime] Fetching macro indicators from FRED...');

  // Parallel fetch of all indicators. Labelled because a failure has to name the series it
  // cost, and `caveats` below is read by the LLM, not only by whoever is watching the log.
  const SERIES: Array<{ id: string; limit: number; label: string }> = [
    { id: 'A191RL1Q225SBEA', limit: 3, label: 'gdpGrowth' },            // Real GDP growth annualized QoQ %
    { id: 'UNRATE', limit: 3, label: 'unemployment' },                  // Unemployment rate %
    { id: 'T10YIE', limit: 5, label: 'inflationExpectation' },          // 10Y breakeven inflation rate (market-implied CPI expectation %)
    { id: 'DGS10', limit: 5, label: 'treasury10y' },                    // 10Y treasury yield %
    { id: 'DGS2', limit: 5, label: 'treasury2y' },                      // 2Y treasury yield %
    { id: 'VIXCLS', limit: 5, label: 'vix' },                           // VIX level
  ];

  const fetched = await Promise.all(SERIES.map((s) => fetchFredSeries(s.id, s.limit)));
  const [gdpGrowth, unemployment, breakeven10y, treasury10y, treasury2y, vix] =
    fetched.map((f) => f.value);
  // Absent for two different reasons, and the difference is whether waiting helps.
  const failedLabels = SERIES.filter((_, i) => fetched[i].failed).map((s) => s.label);
  const blankLabels = SERIES
    .filter((_, i) => !fetched[i].failed && fetched[i].value === null)
    .map((s) => s.label);

  const yieldSpread = treasury10y !== null && treasury2y !== null
    ? treasury10y - treasury2y
    : null;

  const growth = scoreGrowth(gdpGrowth, unemployment);
  const inflation = scoreInflation(breakeven10y);
  const financial = scoreFinancial(yieldSpread, vix);

  // With nothing fetched, every score is its neutral default — and `classifyRegime(0, 0.5, 0)`
  // reads that as `recovery` / `medium`, the most permissive row in `policy.regime` (full size,
  // rsiEntryMin 50). An absent FRED key was therefore indistinguishable from a measured
  // recovery. No data is the maximally ambiguous case, so it takes the same branch the
  // classifier already reserves for ambiguity, and says `low` out loud.
  const measured = [gdpGrowth, unemployment, breakeven10y, treasury10y, treasury2y, vix]
    .filter((v) => v !== null).length;
  const noData = measured === 0;
  const { regime, confidence } = noData
    ? { regime: 'late_cycle' as Regime, confidence: 'low' as const }
    : classifyRegime(growth, inflation, financial);

  // Facts about the data, never advice — the same division `metrics.ts` draws. A partial
  // read used to be visible only in the log line, so the model was handed `recovery` with no
  // way to know it was `expansion` with one indicator missing. It reads this; the log box
  // does not talk to it.
  const caveats: string[] = [];
  if (!FRED_API_KEY) {
    caveats.push('FRED_API_KEY is not set — no indicator was fetched and the regime is a fallback');
  } else {
    // Both branches say the same consequential thing — a dimension was scored from fewer
    // inputs than it has — and differ only on whether the next fetch can fix it. A count
    // alone ("5/6") left the model to guess which series and why.
    if (failedLabels.length > 0) {
      caveats.push(
        `could not fetch ${failedLabels.join(', ')} (request failed, retrying shortly); ` +
          `that dimension is scored from its remaining inputs, so this label may differ from a ` +
          `complete read`,
      );
    }
    if (blankLabels.length > 0) {
      caveats.push(
        `no recent published value for ${blankLabels.join(', ')} (FRED answered, the ` +
          `observations are placeholders); that dimension is scored from its remaining inputs`,
      );
    }
  }

  const result: RegimeClassification = {
    regime,
    confidence,
    scores: { growth, inflation, financial },
    indicators: {
      gdpGrowth,
      unemployment,
      inflationExpectation: breakeven10y,
      yieldSpread10y2y: yieldSpread,
      vix,
    },
    indicatorsMeasured: measured,
    indicatorsTotal: SERIES.length,
    caveats,
    fetchedAt: new Date().toISOString(),
    source: FRED_API_KEY ? 'FRED' : 'fallback',
  };

  // A partial read heals on the next attempt exactly as a total one does, so it earns the
  // same short TTL. Keyed on `failed` rather than on a null value: pinning a 6-hour cache
  // after one 502 turned a momentary gateway error into a whole session of the wrong label,
  // while a series FRED genuinely publishes as blank must NOT drag all six back every 5
  // minutes for the rest of the day.
  const degraded = failedLabels.length > 0;

  if (noData) {
    logger.warn(
      `[Regime] No indicator could be fetched — falling back to ${regime} (low confidence), ` +
        `retrying in ${NO_DATA_TTL_MS / 60_000}m`,
    );
  } else {
    logger.info(
      `[Regime] Classification: ${regime} (${confidence}) — ${measured}/${SERIES.length} indicators, ` +
        `growth=${growth.toFixed(2)} inflation=${inflation.toFixed(2)} financial=${financial.toFixed(2)}`,
    );
    if (degraded) {
      logger.warn(
        `[Regime] Degraded read — could not fetch ${failedLabels.join(', ')}; ` +
          `${regime} (${confidence}) may not survive a complete fetch, retrying in ` +
          `${NO_DATA_TTL_MS / 60_000}m instead of caching for ${CACHE_TTL_MS / 3_600_000}h`,
      );
    }
  }

  _cache = result;
  // Retry soon only if retrying could change the answer: no key is a permanent condition.
  _cacheExpiresAt = now + ((noData || degraded) && FRED_API_KEY ? NO_DATA_TTL_MS : CACHE_TTL_MS);
  return result;
}

/**
 * Synchronous access to the last fetched regime. Returns null if never fetched.
 * Use this in synchronous code paths (e.g., detectors) where await is not possible.
 * The async getRegime() is called by the scheduler/trader on each cycle, so this
 * will be populated after the first cycle.
 */
export function getCachedRegime(): RegimeClassification | null {
  return _cache;
}
