/**
 * L1 — renders the backtest's findings as Markdown, following this codebase's "caveats not
 * verdicts" convention (see `Scorecard.caveats`, `Benchmark.caveats`): every caveat here is a
 * fact about the data or the method, never a grade, a "winner", or advice.
 */

import type { BacktestConfig, ExitMode } from './engine';
import type { Scorecard } from './metrics';
import type { BenchmarkStats } from './benchmarkStats';

function fmtPct(n: number | null): string {
  return n == null ? '—' : `${n.toFixed(2)}%`;
}

function fmtNum(n: number | null): string {
  return n == null ? '—' : n.toFixed(2);
}

function fmtMoney(n: number | null): string {
  return n == null ? '—' : `$${n.toFixed(2)}`;
}

export function renderBaselineReport(
  config: BacktestConfig,
  sc: Scorecard,
  bm: BenchmarkStats,
  runCaveats: string[],
  aiStats?: { calls: number; cacheHits: number },
): string {
  const lines: string[] = [];
  lines.push(`# Backtest report — ${config.exitMode}`);
  lines.push('');
  lines.push(
    aiStats
      ? `Level 1.5 (AI decides entry/exit timing and its own stop-loss/take-profit from mechanical `
        + `signals only — still no news, no fundamentals, no regime). Range ${config.start} `
        + `to ${config.end}, ${(config.slippagePct * 100).toFixed(2)}% slippage, $0 commission, `
        + `starting equity $${config.initialEquity.toFixed(2)}.`
      : `Level 1 (mechanical only — no AI, no news, no fundamentals, no regime). Range ${config.start} `
        + `to ${config.end}, ${(config.slippagePct * 100).toFixed(2)}% slippage, $0 commission, `
        + `starting equity $${config.initialEquity.toFixed(2)}.`,
  );
  lines.push('');

  if (aiStats) {
    lines.push('## AI decision-maker');
    lines.push('');
    lines.push(`- Calls: ${aiStats.calls} (${aiStats.cacheHits} served from cache)`);
    lines.push('');
  }

  lines.push('## Trade statistics');
  lines.push('');
  lines.push(`- Window: ${sc.window.from ?? '—'} to ${sc.window.to ?? '—'}`);
  lines.push(`- Trades: ${sc.trades} (${sc.wins} wins, ${sc.losses} losses, ${sc.scratches} scratches)`);
  lines.push(`- Win rate: ${fmtPct(sc.winRate)}`);
  lines.push(`- Gross P&L: ${fmtMoney(sc.grossPnL)}`);
  lines.push(`- Expectancy: ${fmtMoney(sc.expectancy)} per trade (${fmtPct(sc.expectancyPct)})`);
  lines.push(`- Expectancy in R: ${fmtNum(sc.expectancyR)} (sample ${sc.expectancyRSample} of ${sc.trades})`);
  lines.push(`- Profit factor: ${fmtNum(sc.profitFactor)}`);
  lines.push(`- Return stdev: ${fmtPct(sc.returnPctStdev)}, per-trade sharpe: ${fmtNum(sc.perTradeSharpe)}, expectancy t-stat: ${fmtNum(sc.expectancyTStat)}`);
  lines.push(`- Max drawdown (realised P&L): ${fmtMoney(sc.maxDrawdown)}, max consecutive losses: ${sc.maxConsecutiveLosses}`);
  lines.push(`- Avg hold: ${fmtNum(sc.avgHoldDays)} days (winners ${fmtNum(sc.avgHoldWinnersDays)}, losers ${fmtNum(sc.avgHoldLosersDays)})`);
  lines.push(
    `- Stop discipline: ${sc.stopDiscipline.breached} breach(es), avg stop distance `
    + `${fmtPct(sc.stopDiscipline.avgStopDistancePct)}, avg stop in ATRs ${fmtNum(sc.stopDiscipline.avgStopAtrMultiple)}`,
  );
  lines.push('');

  if (Object.keys(sc.bySymbol).length > 0) {
    lines.push('### By symbol');
    lines.push('');
    lines.push('| Symbol | Trades | Gross P&L | Win rate | Expectancy |');
    lines.push('|---|---|---|---|---|');
    for (const [symbol, g] of Object.entries(sc.bySymbol)) {
      lines.push(`| ${symbol} | ${g.trades} | ${fmtMoney(g.grossPnL)} | ${fmtPct(g.winRate)} | ${fmtMoney(g.expectancy)} |`);
    }
    lines.push('');
  }

  lines.push('## Benchmark — vs. SPY over the same sessions');
  lines.push('');
  lines.push(`- Window: ${bm.window.from ?? '—'} to ${bm.window.to ?? '—'} (${bm.window.sessions} aligned sessions)`);
  lines.push(`- Simulated return: ${fmtPct(bm.portfolioReturnPct)} vs SPY ${fmtPct(bm.spyReturnPct)} — excess ${fmtPct(bm.excessPct)}`);
  lines.push(`- Sharpe: ${fmtNum(bm.portfolioSharpe)} vs SPY ${fmtNum(bm.spySharpe)}`);
  lines.push(`- Annualised vol: ${fmtPct(bm.portfolioVolPct)} vs SPY ${fmtPct(bm.spyVolPct)}`);
  lines.push(`- Max drawdown (equity curve): ${fmtPct(bm.maxDrawdownPct)} vs SPY ${fmtPct(bm.spyMaxDrawdownPct)}`);
  lines.push('');

  const allCaveats = [...runCaveats, ...sc.caveats, ...bm.caveats];
  if (allCaveats.length > 0) {
    lines.push('## Caveats');
    lines.push('');
    for (const c of allCaveats) lines.push(`- ${c}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Sweep ────────────────────────────────────────────────────────────────────────

export interface SweepPoint {
  exitMode: ExitMode;
  compositeMin: number;
  stopLossAtrMult: number;
  positionSizePct: number;
  train: { scorecard: Scorecard; benchmark: BenchmarkStats };
  holdout: { scorecard: Scorecard; benchmark: BenchmarkStats };
}

/**
 * How many grid steps a point is from `neighbor` — 1 means they differ in exactly one
 * parameter by adjacent grid values; the sweep report's stability check only compares points
 * at distance 1.
 */
function isAdjacent(a: SweepPoint, b: SweepPoint, sortedValues: { compositeMin: number[]; stopLossAtrMult: number[]; positionSizePct: number[] }): boolean {
  if (a.exitMode !== b.exitMode) return false;
  const diffs = [
    a.compositeMin !== b.compositeMin,
    a.stopLossAtrMult !== b.stopLossAtrMult,
    a.positionSizePct !== b.positionSizePct,
  ].filter(Boolean).length;
  if (diffs !== 1) return false;

  const adjacentInSeries = (series: number[], x: number, y: number) => {
    const ix = series.indexOf(x);
    const iy = series.indexOf(y);
    return ix >= 0 && iy >= 0 && Math.abs(ix - iy) === 1;
  };
  if (a.compositeMin !== b.compositeMin) return adjacentInSeries(sortedValues.compositeMin, a.compositeMin, b.compositeMin);
  if (a.stopLossAtrMult !== b.stopLossAtrMult) return adjacentInSeries(sortedValues.stopLossAtrMult, a.stopLossAtrMult, b.stopLossAtrMult);
  return adjacentInSeries(sortedValues.positionSizePct, a.positionSizePct, b.positionSizePct);
}

/**
 * Labels each point's TRAIN expectancy as a "plateau" (its immediate grid neighbors perform
 * similarly), a "spike" (neighbors diverge sharply — likely noise, not a real effect), or "edge"
 * (no comparable neighbors in the grid, e.g. a corner point). Never a recommendation — the
 * report states this next to the number, the model or the reader decides what it means.
 */
function classifyStability(points: SweepPoint[]): Map<SweepPoint, 'plateau' | 'spike' | 'edge'> {
  const sortedValues = {
    compositeMin: [...new Set(points.map(p => p.compositeMin))].sort((a, b) => a - b),
    stopLossAtrMult: [...new Set(points.map(p => p.stopLossAtrMult))].sort((a, b) => a - b),
    positionSizePct: [...new Set(points.map(p => p.positionSizePct))].sort((a, b) => a - b),
  };

  const out = new Map<SweepPoint, 'plateau' | 'spike' | 'edge'>();
  for (const p of points) {
    const neighbors = points.filter(q => q !== p && isAdjacent(p, q, sortedValues));
    if (neighbors.length === 0) {
      out.set(p, 'edge');
      continue;
    }
    const own = p.train.scorecard.expectancyPct ?? 0;
    const neighborVals = neighbors.map(n => n.train.scorecard.expectancyPct ?? 0);
    const neighborMean = neighborVals.reduce((a, b) => a + b, 0) / neighborVals.length;
    const spread = neighborVals.length > 1
      ? Math.sqrt(neighborVals.reduce((a, v) => a + (v - neighborMean) ** 2, 0) / neighborVals.length)
      : 0;
    // A point counts as a spike when it sits meaningfully outside its neighbors' own spread —
    // "meaningfully" bounded below at 0.5 percentage points so a flat, near-zero neighborhood
    // (spread ~0) doesn't flag every point as a spike over noise-level differences.
    const threshold = Math.max(spread * 2, 0.5);
    out.set(p, Math.abs(own - neighborMean) > threshold ? 'spike' : 'plateau');
  }
  return out;
}

export function renderSweepReport(points: SweepPoint[]): string {
  const lines: string[] = [];
  lines.push('# Backtest parameter sweep');
  lines.push('');
  lines.push(
    'Level 1 (mechanical only). Train = all but the last 2 years; holdout = the last 2 years. '
    + 'Grid search picks nothing from holdout — it is reported alongside for comparison, never used to choose a "winner". '
    + '`stop_only` rows are the reference: no trailing stop, no take-profit, closest to what production actually enforces mechanically.',
  );
  lines.push('');

  const stability = classifyStability(points);

  lines.push('| Exit mode | compositeMin | stopAtrMult | sizePct | Train trades | Train exp% | Train stability | Holdout trades | Holdout exp% | Holdout excess vs SPY |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const p of points) {
    const stab = stability.get(p) ?? 'edge';
    lines.push(
      `| ${p.exitMode} | ${p.compositeMin} | ${p.stopLossAtrMult} | ${p.positionSizePct} `
      + `| ${p.train.scorecard.trades} | ${fmtPct(p.train.scorecard.expectancyPct)} | ${stab} `
      + `| ${p.holdout.scorecard.trades} | ${fmtPct(p.holdout.scorecard.expectancyPct)} `
      + `| ${fmtPct(p.holdout.benchmark.excessPct)} |`,
    );
  }
  lines.push('');

  const spikes = points.filter(p => stability.get(p) === 'spike');
  const thinHoldouts = points.filter(p => p.holdout.scorecard.trades < 20);
  lines.push('## Caveats');
  lines.push('');
  lines.push('Fees are estimated as 0.05% slippage and $0 commission — no other cost is modelled.');
  if (spikes.length > 0) {
    lines.push(`${spikes.length} of ${points.length} grid point(s) are flagged "spike": their train expectancy diverges sharply from adjacent grid points, which is more consistent with noise than with a real effect.`);
  }
  if (thinHoldouts.length > 0) {
    lines.push(`${thinHoldouts.length} of ${points.length} grid point(s) have fewer than 20 holdout trades — too few to distinguish skill from variance in the holdout column.`);
  }
  lines.push('');

  return lines.join('\n');
}
