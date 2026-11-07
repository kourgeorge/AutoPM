/**
 * L1 — the same date-aligned comparison `src/review/benchmark.ts`'s `benchmark()` runs against
 * the live equity curve, adapted to compare the SIMULATED equity curve against real SPY daily
 * bars over the backtest's own date range.
 *
 * Dates are aligned as plain `YYYY-MM-DD` strings sliced from each bar's `t` — the same
 * convention `engine.ts` already uses to build its trading calendar — rather than ET-converted
 * as `benchmark.ts` does, so both series speak the identical date convention the engine itself
 * used to decide when the market was open. `cashFlowsInWindow` has no backtest equivalent —
 * there are no real deposits or withdrawals — so it's simply omitted rather than stubbed.
 */

import type { EquityPoint } from './engine';
import { getHistoricalBars } from './barCache';
import { dailyReturns, annualisedSharpe, annualisedVolPct, maxDrawdownPct, MIN_RETURNS_FOR_SHARPE } from '../review/benchmark';

const THIN_SESSIONS = 30;

export interface BenchmarkStats {
  window: { from: string | null; to: string | null; sessions: number };

  portfolioReturnPct: number | null;
  spyReturnPct: number | null;
  excessPct: number | null;

  portfolioSharpe: number | null;
  spySharpe: number | null;
  portfolioVolPct: number | null;
  spyVolPct: number | null;

  maxDrawdownPct: number | null;
  spyMaxDrawdownPct: number | null;

  caveats: string[];
}

// One copy of the return statistics, shared with the live benchmark so the two cannot drift.
function r(n: number | null, dp = 2): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export async function benchmarkStats(
  equityCurve: EquityPoint[],
  start: string,
  end: string,
): Promise<BenchmarkStats> {
  const caveats: string[] = [];

  const equitySeries = new Map(equityCurve.map(p => [p.date, p.equity]));
  const spyBars = await getHistoricalBars('SPY', start, end);
  const spySeries = new Map(spyBars.map(b => [b.t.slice(0, 10), b.c]));

  if (spySeries.size === 0) caveats.push('SPY bars unavailable for this range — no benchmark comparison.');

  const dates = [...equitySeries.keys()].filter(d => spySeries.has(d)).sort();
  const equityDates = dates.length > 0 ? dates : [...equitySeries.keys()].sort();
  const spyDates = dates.length > 0 ? dates : [...spySeries.keys()].sort();

  const equityLevels = equityDates.map(d => equitySeries.get(d)!).filter(Number.isFinite);
  const spyLevels = spyDates.map(d => spySeries.get(d)!).filter(Number.isFinite);

  const totalReturnPct = (levels: number[]): number | null =>
    levels.length >= 2 && levels[0] > 0 ? (levels[levels.length - 1] / levels[0] - 1) * 100 : null;

  const portfolioReturnPct = totalReturnPct(equityLevels);
  const spyReturnPct = totalReturnPct(spyLevels);

  const equityReturns = dailyReturns(equityLevels);
  const spyReturns = dailyReturns(spyLevels);

  const sessions = dates.length;
  const from = (dates[0] ?? equityDates[0] ?? spyDates[0]) ?? null;
  const to = (dates[dates.length - 1] ?? equityDates[equityDates.length - 1] ?? spyDates[spyDates.length - 1]) ?? null;

  if (equityLevels.length > 0 && spyLevels.length > 0 && sessions === 0) {
    caveats.push('the simulated equity curve and the SPY series share no dates, so nothing here is a comparison.');
  }
  if (sessions > 0 && sessions < THIN_SESSIONS) {
    caveats.push(`window is ${sessions} session(s) — too short for a meaningful comparison.`);
  }
  if (equityReturns.length > 0 && equityReturns.length < MIN_RETURNS_FOR_SHARPE) {
    caveats.push(`only ${equityReturns.length} daily return(s) — no standard deviation is reported below ${MIN_RETURNS_FOR_SHARPE}, so the Sharpe figures are null rather than noisy.`);
  }
  if (equityReturns.length >= MIN_RETURNS_FOR_SHARPE) {
    caveats.push('Sharpe figures use a zero risk-free rate on both legs — read them as return per unit of volatility, and compare the simulation to SPY rather than to a textbook threshold.');
  }
  caveats.push('0.05% slippage and $0 commission are baked into fill prices; no other cost (spread, borrow, tax) is modelled.');

  return {
    window: { from, to, sessions },

    portfolioReturnPct: r(portfolioReturnPct),
    spyReturnPct: r(spyReturnPct),
    excessPct:
      portfolioReturnPct != null && spyReturnPct != null && sessions > 0
        ? r(portfolioReturnPct - spyReturnPct)
        : null,

    portfolioSharpe: r(annualisedSharpe(equityReturns)),
    spySharpe: r(annualisedSharpe(spyReturns)),
    portfolioVolPct: r(annualisedVolPct(equityReturns)),
    spyVolPct: r(annualisedVolPct(spyReturns)),

    maxDrawdownPct: r(maxDrawdownPct(equityLevels)),
    spyMaxDrawdownPct: r(maxDrawdownPct(spyLevels)),

    caveats,
  };
}
