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
  fetchedAt: string;
  source: string;
}

// ── FRED fetcher ─────────────────────────────────────────────────────────────

async function fetchFredSeries(seriesId: string, limit = 5): Promise<number | null> {
  if (!FRED_API_KEY) {
    logger.warn(`[Regime] FRED_API_KEY not set, cannot fetch ${seriesId}`);
    return null;
  }

  try {
    const res = await axios.get(FRED_BASE_URL, {
      params: {
        series_id: seriesId,
        api_key: FRED_API_KEY,
        file_type: 'json',
        limit,
        sort_order: 'desc',
      },
      timeout: 10_000,
    });

    const observations = res.data?.observations ?? [];
    for (const obs of observations) {
      if (obs.value != null && obs.value !== '.') {
        return parseFloat(obs.value);
      }
    }
    return null;
  } catch (err: any) {
    logger.error(`[Regime] Failed to fetch FRED series ${seriesId}: ${err.message}`);
    return null;
  }
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
 * A classification drawn from NO indicators is cached only this long. The 6-hour TTL is
 * justified by the regime changing slowly; a fetch failure does not change slowly, and
 * pinning the fallback for six hours turned one FRED outage into a whole session of it.
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

  // Parallel fetch of all indicators
  const [gdpGrowth, unemployment, breakeven10y, treasury10y, treasury2y, vix] = await Promise.all([
    fetchFredSeries('A191RL1Q225SBEA', 3),  // Real GDP growth annualized QoQ %
    fetchFredSeries('UNRATE', 3),            // Unemployment rate %
    fetchFredSeries('T10YIE', 5),            // 10Y breakeven inflation rate (market-implied CPI expectation %)
    fetchFredSeries('DGS10', 5),             // 10Y treasury yield %
    fetchFredSeries('DGS2', 5),              // 2Y treasury yield %
    fetchFredSeries('VIXCLS', 5),            // VIX level
  ]);

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
    fetchedAt: new Date().toISOString(),
    source: FRED_API_KEY ? 'FRED' : 'fallback',
  };

  if (noData) {
    logger.warn(
      `[Regime] No indicator could be fetched — falling back to ${regime} (low confidence), ` +
        `retrying in ${NO_DATA_TTL_MS / 60_000}m`,
    );
  } else {
    logger.info(
      `[Regime] Classification: ${regime} (${confidence}) — ${measured}/6 indicators, ` +
        `growth=${growth.toFixed(2)} inflation=${inflation.toFixed(2)} financial=${financial.toFixed(2)}`,
    );
  }

  _cache = result;
  // Retry soon only if retrying could change the answer: no key is a permanent condition.
  _cacheExpiresAt = now + (noData && FRED_API_KEY ? NO_DATA_TTL_MS : CACHE_TTL_MS);
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
