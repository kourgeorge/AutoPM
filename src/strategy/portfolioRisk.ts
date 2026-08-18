/**
 * Portfolio-level risk management: volatility-scaled sizing and correlation gating.
 *
 * Inspired by Ang, Azimbayev & Kim (2026) "The Self-Driving Portfolio" — adapted
 * from institutional SAA (20 PC agents, inverse-vol heuristics) to a concentrated
 * momentum book where the same principles apply at position level.
 *
 * Two functions are exported for use by the guard layer (orderManager.ts):
 *  - volatilityScaledQty: sizes positions inversely to ATR for equal risk contribution
 *  - correlationGate: checks correlation of candidate entry against existing holdings
 */

import { collectBars } from '../collect/barSource';
import { isPresent } from '../collect/types';
import { getPolicy } from '../policy/load';
import { broker } from '../broker';
import { logger } from '../core/logger';
import { sameSymbol } from '../core/symbols';

// ── Volatility-scaled position sizing ────────────────────────────────────────

/**
 * Compute position size using inverse-volatility scaling.
 *
 * Instead of a flat positionSizePct, each position gets a dollar risk budget
 * proportional to 1/ATR. This equalizes the expected dollar risk per position:
 * a stock with 2x the ATR gets half the shares.
 *
 * Formula:
 *   dollarBudget = equity × positionSizePct
 *   riskPerShare = atr × stopLossAtrMult  (the distance to the stop)
 *   qty = dollarBudget / riskPerShare
 *
 * This is the standard "fixed fractional risk" sizing used by trend-followers
 * (cf. Van Tharp, Kirby & Ostdiek 2012 inverse-volatility from the paper's Exhibit 5).
 */
export function volatilityScaledQty(
  equity: number,
  price: number,
  atr: number,
): number {
  const policy = getPolicy();
  const { positionSizePct, stopLossAtrMult } = policy.risk;

  // Dollar risk budget for this position
  const dollarBudget = equity * positionSizePct;

  // Risk per share = distance from entry to stop (ATR × multiplier)
  const riskPerShare = atr * stopLossAtrMult;

  if (riskPerShare <= 0 || !Number.isFinite(riskPerShare)) {
    // Fallback to simple dollar-based sizing
    return Math.floor(dollarBudget / price);
  }

  // Qty = budget / risk per share, but also capped by dollar budget / price
  // (we can't spend more than the budget in total notional)
  const qtyByRisk = dollarBudget / riskPerShare;
  const qtyByNotional = dollarBudget / price;

  // Zero when one share does not fit the budget, and zero is the honest answer: a trailing
  // `Math.max(qty, 1)` used to report 1 there, which on a high-priced asset recommended a
  // position many times the equity (measured: $10k equity, $118k price -> qty 1 = 1180%).
  // It also disagreed with the `riskPerShare <= 0` branch above, which floors to 0 already.
  return Math.floor(Math.min(qtyByRisk, qtyByNotional));
}

// ── Shared correlation primitives ─────────────────────────────────────────────

/**
 * The window and the minimum sample. One pair of numbers rather than two: if the entry gate
 * looked back 60 bars and the book view looked back 90, the same two symbols would carry two
 * different correlations depending on which tool the model happened to ask.
 *
 * Module-private, because `returnsMatrix` and `correlate` below are what the other callers
 * consume — they apply these themselves, so nobody needs to hold the constants to agree.
 */
const LOOKBACK_DAYS = 60;
const MIN_RETURNS = 15;

/**
 * Memo of the reduced return series, keyed by symbol.
 *
 * `collectBars` has no cache of its own, and three separate paths ask for correlations inside
 * a single LLM cycle: `buildPortfolioContext` calls `exposure()` unconditionally, then the
 * model may call `get_exposure` and `get_correlation`. For a six-name book that was 19 Yahoo
 * chart requests per cycle where 7 suffice, for a DAILY series that cannot change within one.
 *
 * The window is minutes rather than hours only so a long-running daemon still picks up today's
 * bar; correctness does not depend on it, since the series is daily and the consumers are
 * correlations rather than prices. Bounded by the symbols in the book plus whatever the model
 * asks about, and entries are replaced rather than accumulated per call.
 */
const RETURNS_CACHE_MS = 10 * 60 * 1000;
const _returnsCache = new Map<string, { at: number; returns: number[] }>();

/**
 * Fetch bars ONCE PER SYMBOL, concurrently, and reduce each to its return series.
 *
 * O(n) fetches, not O(n²): correlation is a pairwise measure, so a loop written over PAIRS
 * requests the same symbol once per partner — 15 requests for a 6-name book where 6 suffice,
 * and serially at that. Correlating in memory afterwards is free. Symbols whose bars are
 * missing or too short are simply absent from the map; the caller decides whether that is a
 * caveat or a fail-open.
 */
export async function returnsMatrix(symbols: string[]): Promise<Map<string, number[]>> {
  const unique = [...new Set(symbols)];
  const now = Date.now();

  const fetched = await Promise.all(
    unique.map(async (symbol) => {
      const hit = _returnsCache.get(symbol);
      if (hit && now - hit.at < RETURNS_CACHE_MS) return { symbol, returns: hit.returns };

      const bars = await collectBars(symbol, LOOKBACK_DAYS);
      const returns = isPresent(bars) ? dailyReturns(bars.value) : null;
      // A failed or too-short fetch is NOT cached: it would pin a fail-open for the window,
      // and unlike a bar series a failure can change on the next call.
      if (returns && returns.length >= MIN_RETURNS) _returnsCache.set(symbol, { at: now, returns });
      return { symbol, returns };
    }),
  );

  const out = new Map<string, number[]>();
  for (const { symbol, returns } of fetched) {
    if (returns && returns.length >= MIN_RETURNS) out.set(symbol, returns);
  }
  return out;
}

/**
 * Correlate two return series, aligning them on their common tail.
 *
 * `null` means "not enough overlap to say", which is not the same fact as 0 — a zero
 * correlation is a measurement, and reporting one for an unmeasurable pair would put a
 * number the data does not support in front of the model.
 */
export function correlate(ra: number[], rb: number[]): number | null {
  const len = Math.min(ra.length, rb.length);
  if (len < MIN_RETURNS) return null;
  return pearsonCorrelation(ra.slice(-len), rb.slice(-len));
}

// ── Correlation-aware entry gating ───────────────────────────────────────────

export interface CorrelationResult {
  allowed: boolean;
  maxCorrelation: number;
  mostCorrelatedWith: string | null;
  sizeMultiplier: number; // 1.0 = full size, <1.0 = downsize due to correlation
  detail: string;
}

/**
 * Check whether a new entry is too correlated with existing holdings.
 *
 * Uses trailing 30-day daily returns to compute pairwise Pearson correlation
 * between the candidate and each current position. If any pair exceeds a
 * threshold, the position is downsized or vetoed.
 *
 * Thresholds (from policy or defaults):
 *  - correlation > 0.85: veto (too redundant)
 *  - correlation > 0.70: downsize to 50%
 *  - correlation <= 0.70: full size
 *
 * Fails open: if bars can't be fetched, allows entry at full size.
 */
export async function correlationGate(
  candidateSymbol: string,
): Promise<CorrelationResult> {
  const VETO_THRESHOLD = 0.85;
  const DOWNSIZE_THRESHOLD = 0.70;
  const DOWNSIZE_MULT = 0.5;

  const pass = (detail: string): CorrelationResult => ({
    allowed: true,
    maxCorrelation: 0,
    mostCorrelatedWith: null,
    sizeMultiplier: 1.0,
    detail,
  });

  try {
    const positions = await broker.getPositions();

    // A held candidate must not be correlated against ITSELF. Left in, the self-pair scores
    // 1.0 and vetoes, which made `get_correlation` on anything already in the book report a
    // redundancy that does not exist.
    const others = positions
      .map((p) => p.symbol)
      .filter((symbol) => !sameSymbol(symbol, candidateSymbol));

    if (others.length === 0) {
      return pass(
        positions.length === 0
          ? 'no existing positions'
          : `${candidateSymbol} is the only holding — nothing to correlate against`,
      );
    }

    const returns = await returnsMatrix([candidateSymbol, ...others]);

    const candidateReturns = returns.get(candidateSymbol);
    if (!candidateReturns) {
      return pass('candidate bars or return history unavailable — fail open');
    }

    let maxCorr = 0;
    let maxCorrSymbol: string | null = null;

    for (const symbol of others) {
      const held = returns.get(symbol);
      if (!held) continue;

      const corr = correlate(candidateReturns, held);
      if (corr === null) continue;

      if (Math.abs(corr) > Math.abs(maxCorr)) {
        maxCorr = corr;
        maxCorrSymbol = symbol;
      }
    }

    if (maxCorr > VETO_THRESHOLD) {
      logger.info(`[PortfolioRisk] Correlation veto: ${candidateSymbol} \u2194 ${maxCorrSymbol} = ${maxCorr.toFixed(3)}`);
      return {
        allowed: false,
        maxCorrelation: maxCorr,
        mostCorrelatedWith: maxCorrSymbol,
        sizeMultiplier: 0,
        detail: `correlation ${maxCorr.toFixed(2)} with ${maxCorrSymbol} exceeds ${VETO_THRESHOLD} \u2014 entry blocked`,
      };
    }

    if (maxCorr > DOWNSIZE_THRESHOLD) {
      logger.info(`[PortfolioRisk] Correlation downsize: ${candidateSymbol} \u2194 ${maxCorrSymbol} = ${maxCorr.toFixed(3)} \u2014 sizing \u00d7${DOWNSIZE_MULT}`);
      return {
        allowed: true,
        maxCorrelation: maxCorr,
        mostCorrelatedWith: maxCorrSymbol,
        sizeMultiplier: DOWNSIZE_MULT,
        detail: `correlation ${maxCorr.toFixed(2)} with ${maxCorrSymbol} exceeds ${DOWNSIZE_THRESHOLD} \u2014 position halved`,
      };
    }

    return {
      allowed: true,
      maxCorrelation: maxCorr,
      mostCorrelatedWith: maxCorrSymbol,
      sizeMultiplier: 1.0,
      detail: maxCorrSymbol
        ? `max correlation ${maxCorr.toFixed(2)} with ${maxCorrSymbol} \u2014 within limits`
        : 'no correlations computed',
    };
  } catch (err: any) {
    logger.warn(`[PortfolioRisk] Correlation check failed \u2014 fail open: ${err.message}`);
    return { allowed: true, maxCorrelation: 0, mostCorrelatedWith: null, sizeMultiplier: 1.0, detail: `error: ${err.message} \u2014 fail open` };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute daily log returns from a bar series.
 *
 * Module-private: `returnsMatrix` is the only way in. Held-vs-held correlation and the entry
 * correlation gate MUST share this arithmetic — two implementations would report two different
 * numbers for the same pair and the model would get two truths — and the way to guarantee that
 * is to leave callers no arithmetic to re-do, not to export the pieces and hope they agree.
 */
function dailyReturns(bars: { c: number }[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i - 1].c > 0) {
      returns.push(Math.log(bars[i].c / bars[i - 1].c));
    }
  }
  return returns;
}

/** Pearson correlation coefficient between two equal-length arrays. Reached via `correlate`. */
function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n === 0) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }

  const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (denom === 0) return 0;

  return (n * sumXY - sumX * sumY) / denom;
}
