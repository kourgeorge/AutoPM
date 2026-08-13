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
  const qty = Math.floor(Math.min(qtyByRisk, qtyByNotional));

  return Math.max(qty, 1); // at least 1 share
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
  const LOOKBACK_DAYS = 60; // fetch 60 bars, use for 30-day returns

  try {
    const positions = await broker.getPositions();
    if (positions.length === 0) {
      return { allowed: true, maxCorrelation: 0, mostCorrelatedWith: null, sizeMultiplier: 1.0, detail: 'no existing positions' };
    }

    // Fetch bars for the candidate
    const candidateBars = await collectBars(candidateSymbol, LOOKBACK_DAYS);
    if (!isPresent(candidateBars)) {
      return { allowed: true, maxCorrelation: 0, mostCorrelatedWith: null, sizeMultiplier: 1.0, detail: 'candidate bars unavailable — fail open' };
    }

    const candidateReturns = dailyReturns(candidateBars.value);
    if (candidateReturns.length < 15) {
      return { allowed: true, maxCorrelation: 0, mostCorrelatedWith: null, sizeMultiplier: 1.0, detail: 'insufficient return history — fail open' };
    }

    let maxCorr = 0;
    let maxCorrSymbol: string | null = null;

    for (const pos of positions) {
      const posBars = await collectBars(pos.symbol, LOOKBACK_DAYS);
      if (!isPresent(posBars)) continue;

      const posReturns = dailyReturns(posBars.value);
      // Align lengths
      const len = Math.min(candidateReturns.length, posReturns.length);
      if (len < 15) continue;

      const corr = pearsonCorrelation(
        candidateReturns.slice(-len),
        posReturns.slice(-len),
      );

      if (Math.abs(corr) > Math.abs(maxCorr)) {
        maxCorr = corr;
        maxCorrSymbol = pos.symbol;
      }
    }

    if (maxCorr > VETO_THRESHOLD) {
      logger.info(`[PortfolioRisk] Correlation veto: ${candidateSymbol} ↔ ${maxCorrSymbol} = ${maxCorr.toFixed(3)}`);
      return {
        allowed: false,
        maxCorrelation: maxCorr,
        mostCorrelatedWith: maxCorrSymbol,
        sizeMultiplier: 0,
        detail: `correlation ${maxCorr.toFixed(2)} with ${maxCorrSymbol} exceeds ${VETO_THRESHOLD} — entry blocked`,
      };
    }

    if (maxCorr > DOWNSIZE_THRESHOLD) {
      logger.info(`[PortfolioRisk] Correlation downsize: ${candidateSymbol} ↔ ${maxCorrSymbol} = ${maxCorr.toFixed(3)} — sizing ×${DOWNSIZE_MULT}`);
      return {
        allowed: true,
        maxCorrelation: maxCorr,
        mostCorrelatedWith: maxCorrSymbol,
        sizeMultiplier: DOWNSIZE_MULT,
        detail: `correlation ${maxCorr.toFixed(2)} with ${maxCorrSymbol} exceeds ${DOWNSIZE_THRESHOLD} — position halved`,
      };
    }

    return {
      allowed: true,
      maxCorrelation: maxCorr,
      mostCorrelatedWith: maxCorrSymbol,
      sizeMultiplier: 1.0,
      detail: maxCorrSymbol
        ? `max correlation ${maxCorr.toFixed(2)} with ${maxCorrSymbol} — within limits`
        : 'no correlations computed',
    };
  } catch (err: any) {
    logger.warn(`[PortfolioRisk] Correlation check failed — fail open: ${err.message}`);
    return { allowed: true, maxCorrelation: 0, mostCorrelatedWith: null, sizeMultiplier: 1.0, detail: `error: ${err.message} — fail open` };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Compute daily log returns from a bar series. */
function dailyReturns(bars: { c: number }[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i - 1].c > 0) {
      returns.push(Math.log(bars[i].c / bars[i - 1].c));
    }
  }
  return returns;
}

/** Pearson correlation coefficient between two equal-length arrays. */
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
