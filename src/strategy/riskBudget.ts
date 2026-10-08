import type { Bar } from '../core/types';
import { datedReturns } from './returnSeries';
import type { Position } from '../broker/IBroker';
import type { Policy } from '../policy/types';
import { hasRiskProfile } from '../policy/riskProfiles';
import { sameSymbol } from '../core/symbols';

export const VOLATILITY_LOOKBACK = 60;
export const MIN_VOLATILITY_RETURNS = 30;
const SESSIONS_PER_YEAR = 252;

export interface RiskInputs {
  histories: Record<string, Bar[]>;
  sectors: Record<string, string | null>;
  /** Last completed session. Live readers verify this against the exchange calendar. */
  asOf: string | null;
  errors: Record<string, string>;
}

export interface RiskAssessment {
  allowed: boolean;
  maxQty: number;
  qty: number;
  entryPrice: number;
  plannedLoss: number;
  plannedLossPct: number;
  rewardRisk: number | null;
  volatilityBeforePct: number | null;
  volatilityAfterPct: number | null;
  candidateVolatilityPct: number | null;
  targetVolatilityPct: number | null;
  observations: number;
  asOf: string | null;
  limits: Record<string, number>;
  violations: Array<{ rule: string; message: string }>;
  caveats: string[];
}

/** Use the same worst entry price in planning, risk calculations and the IOC order. */
export function entryLimitPrice(expected: number, quote: number): number {
  return Math.floor(Math.min(expected * 1.01, quote * 1.002) * 100) / 100;
}


function covariance(a: number[], b: number[]): number {
  const meanA = a.reduce((sum, n) => sum + n, 0) / a.length;
  const meanB = b.reduce((sum, n) => sum + n, 0) / b.length;
  return a.reduce((sum, n, i) => sum + (n - meanA) * (b[i] - meanB), 0) / (a.length - 1) * SESSIONS_PER_YEAR;
}

export function volatilityModel(symbol: string, positions: Position[], equity: number, inputs: RiskInputs) {
  if (!inputs.asOf) throw new Error(inputs.errors.calendar ?? 'Completed session is unavailable');
  const symbols = [...new Set([...positions.map(p => p.symbol), symbol])];
  const series = symbols.map(s => {
    if (inputs.errors[s]) throw new Error(`${s}: ${inputs.errors[s]}`);
    if (!inputs.histories[s]) throw new Error(`${s}: daily history unavailable`);
    return datedReturns(inputs.histories[s], inputs.asOf!);
  });
  const intervals = [...series[0].keys()].filter(day => series.every(s => s.has(day))).sort();
  if (intervals.length < MIN_VOLATILITY_RETURNS || !intervals.at(-1)?.endsWith('/' + inputs.asOf)) {
    throw new Error(`Need at least ${MIN_VOLATILITY_RETURNS} aligned daily returns through ${inputs.asOf}; have ${intervals.length}`);
  }
  const vectors = new Map(symbols.map((s, i) => [s, intervals.map(day => series[i].get(day)!)]));
  const book = intervals.map((_, i) => positions.reduce((sum, p) => sum + p.marketValue! / equity * vectors.get(p.symbol)![i], 0));
  const candidate = vectors.get(symbol)!;
  const model = { candidateVariance: covariance(candidate, candidate), bookVariance: covariance(book, book),
    crossCovariance: covariance(book, candidate), observations: intervals.length };
  if (!Object.values(model).every(Number.isFinite)) throw new Error('Portfolio covariance is not finite');
  return model;
}

/**
 * Shared by planning, live validation and historical simulation. With qty omitted it sizes
 * the trade; with qty supplied it validates that exact size (including a partial approval).
 * A null target is only a sizing preview; it cannot establish that a trade clears reward:risk.
 */
export function assessEntryRisk(args: {
  symbol: string; price: number; stopLoss: number; takeProfit: number | null;
  equity: number; buyingPower: number; positions: Position[]; policy: Policy;
  inputs: RiskInputs; qty?: number;
}): RiskAssessment {
  const { symbol, price, stopLoss, takeProfit, equity, buyingPower, positions, policy, inputs } = args;
  const risk = policy.risk;
  const violations: RiskAssessment['violations'] = [];
  const caveats = ['Planned stop loss excludes gaps, slippage and fees. Volatility is a historical estimate, not a guaranteed limit.'];
  const result: RiskAssessment = { allowed: false, maxQty: 0, qty: args.qty ?? 0, entryPrice: price,
    plannedLoss: 0, plannedLossPct: 0, rewardRisk: null,
    volatilityBeforePct: null, volatilityAfterPct: null, candidateVolatilityPct: null,
    targetVolatilityPct: risk.targetVolatilityPct, observations: 0, asOf: inputs.asOf,
    limits: {}, violations, caveats };
  const refuse = (rule: string, message: string) => violations.push({ rule, message });
  if (![price, stopLoss, equity, buyingPower].every(Number.isFinite) || price <= stopLoss || stopLoss <= 0 || equity <= 0 || buyingPower < 0 ||
      (takeProfit != null && (!Number.isFinite(takeProfit) || takeProfit <= price)) ||
      (args.qty != null && (!Number.isSafeInteger(args.qty) || args.qty <= 0))) {
    refuse('invalid_risk_input', 'Risk sizing needs positive equity, valid prices and a whole-share quantity');
    return result;
  }
  if (positions.some(p => !Number.isFinite(p.marketValue) || !Number.isFinite(p.qty))) {
    refuse('risk_data_unavailable', 'Every holding needs a current market value to measure portfolio risk');
    return result;
  }
  if (positions.some(p => sameSymbol(p.symbol, symbol))) refuse('already_holding', 'Already holding this symbol');
  if (positions.length >= risk.maxPositions) refuse('max_positions', 'No position slots remain');
  const distance = price - stopLoss;
  const gross = positions.reduce((sum, p) => sum + Math.abs(p.marketValue!), 0);
  const cap = (label: string, dollars: number, unitCost = price) => {
    result.limits[label] = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(dollars / unitCost + 1e-9)));
  };
  cap('position_weight', equity * risk.positionSizePct);
  cap('buying_power', buyingPower);
  cap('gross_exposure', equity * risk.maxGrossExposurePct - gross);
  if (risk.riskPerTradePct != null) cap('risk_per_trade', equity * risk.riskPerTradePct / 100, distance);
  if (hasRiskProfile(risk)) {
    cap('single_name', equity * risk.maxSingleWeightPct / 100);
    const candidateSector = inputs.sectors[symbol];
    const buckets: Record<string, number> = Object.create(null);
    let unknown = 0;
    for (const p of positions) {
      const sector = inputs.sectors[p.symbol];
      if (!sector) unknown += Math.abs(p.marketValue!);
      else buckets[sector] = (buckets[sector] ?? 0) + Math.abs(p.marketValue!);
    }
    // Missing classifications never create free sector headroom. For an unknown candidate,
    // use the largest possible overlap. This is deliberately conservative for broad ETFs.
    const overlap = unknown + (candidateSector ? buckets[candidateSector] ?? 0 : Math.max(0, ...Object.values(buckets)));
    cap('sector_weight', equity * risk.maxSectorWeightPct / 100 - overlap);
    if (!candidateSector || unknown > 0) caveats.push('Unknown sectors count toward the largest possible sector overlap; ETF constituents are not modeled.');
  }
  result.rewardRisk = takeProfit == null ? null : (takeProfit - price) / distance;
  if (takeProfit == null) caveats.push('Sizing preview only: provide a supported profit target with get_entry_plan to check reward:risk.');
  if (result.rewardRisk != null && risk.minRewardRisk != null && result.rewardRisk + 1e-10 < risk.minRewardRisk) {
    refuse('reward_risk_too_low', `Planned reward:risk ${result.rewardRisk.toFixed(2)} is below ${risk.minRewardRisk}:1 at the entry limit`);
  }

  let model: ReturnType<typeof volatilityModel> | null = null;
  if (risk.targetVolatilityPct != null) {
    try {
      model = volatilityModel(symbol, positions, equity, inputs);
      result.observations = model.observations;
      result.volatilityBeforePct = Math.sqrt(Math.max(0, model.bookVariance)) * 100;
      result.candidateVolatilityPct = Math.sqrt(Math.max(0, model.candidateVariance)) * 100;
      const targetVariance = (risk.targetVolatilityPct / 100) ** 2;
      const { candidateVariance: a, crossCovariance: b, bookVariance: c } = model;
      const discriminant = b * b - a * (c - targetVariance);
      if (a > 1e-16) {
        const maxWeight = discriminant < 0 ? 0 : Math.max(0, (-b + Math.sqrt(discriminant)) / a);
        cap('portfolio_volatility', equity * maxWeight);
      } else if (c > targetVariance + 1e-12) {
        result.limits.portfolio_volatility = 0;
      }
    } catch (err) {
      refuse('risk_data_unavailable', err instanceof Error ? err.message : String(err));
    }
  }
  result.maxQty = Math.min(...Object.values(result.limits));
  if (violations.length) result.maxQty = 0;
  result.qty = args.qty ?? result.maxQty;
  result.plannedLoss = result.qty * distance;
  result.plannedLossPct = result.plannedLoss / equity * 100;
  if (model) {
    const weight = result.qty * price / equity;
    const variance = model.bookVariance + 2 * weight * model.crossCovariance + weight * weight * model.candidateVariance;
    result.volatilityAfterPct = Math.sqrt(Math.max(0, variance)) * 100;
    // Also check the lower root: a smaller hedge can fail when the current book is over target.
    if (result.volatilityAfterPct > risk.targetVolatilityPct! + 1e-8) {
      refuse('portfolio_volatility', `Estimated portfolio volatility ${result.volatilityAfterPct.toFixed(2)}% exceeds the ${risk.targetVolatilityPct}% target`);
      if (args.qty == null) result.maxQty = 0;
    }
  }
  for (const [rule, max] of Object.entries(result.limits)) {
    if (result.qty > max) refuse(rule, `${rule}: at most ${max} shares fit the current risk budget`);
  }
  if (result.maxQty === 0 && violations.length === 0) {
    refuse('risk_budget_exhausted', `No whole share fits: ${Object.entries(result.limits).filter(([, q]) => q === 0).map(([key]) => key).join(', ')}`);
  }
  result.allowed = violations.length === 0 && result.qty > 0;
  return result;
}
