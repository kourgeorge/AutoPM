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
// One copy of the date matching and return statistics, shared with the live benchmark so the two cannot drift.
import { compareSeries, MIN_RETURNS_FOR_SHARPE } from '../review/benchmark';

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

  // The backtest keeps maxDrawdownPct even when the portfolio return is null (no
  // `drawdownNeedsReturn`), unlike the live report.
  const cmp = compareSeries(equitySeries, spySeries);
  const { sessions } = cmp.window;

  if (cmp.equityLevelCount > 0 && cmp.spyLevelCount > 0 && sessions === 0) {
    caveats.push('the simulated equity curve and the SPY series share no dates, so nothing here is a comparison.');
  }
  if (sessions > 0 && sessions < THIN_SESSIONS) {
    caveats.push(`window is ${sessions} session(s) — too short for a meaningful comparison.`);
  }
  if (cmp.equityReturnCount > 0 && cmp.equityReturnCount < MIN_RETURNS_FOR_SHARPE) {
    caveats.push(`only ${cmp.equityReturnCount} daily return(s) — no standard deviation is reported below ${MIN_RETURNS_FOR_SHARPE}, so the Sharpe figures are null rather than noisy.`);
  }
  if (cmp.equityReturnCount >= MIN_RETURNS_FOR_SHARPE) {
    caveats.push('Sharpe figures use a zero risk-free rate on both legs — read them as return per unit of volatility, and compare the simulation to SPY rather than to a textbook threshold.');
  }
  caveats.push('0.05% slippage and $0 commission are baked into fill prices; no other cost (spread, borrow, tax) is modelled.');

  return {
    window: cmp.window,
    ...cmp.fields,
    caveats,
  };
}
