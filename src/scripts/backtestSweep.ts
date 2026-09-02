/**
 * The Level 1 parameter sweep — every combination of exit mode, `compositeMin`,
 * `stopLossAtrMult`, and `positionSizePct` in the grid below, each split by calendar date into
 * train (everything before the holdout window) and holdout (the last 2 years). Grid search
 * only ever looks at train numbers; holdout numbers are reported alongside for comparison and
 * are never used to pick a "winner" — see `src/backtest/report.ts`'s `renderSweepReport`.
 *
 * The holdout run has less pre-window history to warm up its indicators on than the live
 * system would have at the same calendar date (it only sees bars from its own fetch range) —
 * expect fewer signal opportunities in its first couple of months. That's a caveat, not a bug.
 *
 * Same `AI_API_KEY`-at-import-time note as `backtest.ts` applies here.
 *
 *   npm run backtest:sweep
 */

import path from 'path';
import fs from 'fs';
import type { Policy } from '../policy/types';
import { getPolicy } from '../policy/load';
import { ensureDataDir } from '../core/paths';
import { runBacktest, type ExitMode } from '../backtest/engine';
import { scorecard } from '../backtest/metrics';
import { benchmarkStats } from '../backtest/benchmarkStats';
import { renderSweepReport, type SweepPoint } from '../backtest/report';

const START = '2016-01-01';
const HOLDOUT_YEARS = 2;
const SLIPPAGE_PCT = 0.0005;
const INITIAL_EQUITY = 100_000;
const TAKE_PROFIT_R_MULT = 2;
const OUT_DIR = path.join(process.cwd(), 'backtest-results');

const EXIT_MODES: ExitMode[] = ['stop_only', 'stop_trailing', 'stop_takeprofit'];
const COMPOSITE_MIN_GRID = [0.1, 0.2, 0.3];
const STOP_LOSS_ATR_MULT_GRID = [1.5, 2, 3];
const POSITION_SIZE_PCT_GRID = [0.05, 0.1, 0.15];

function withOverrides(policy: Policy, compositeMin: number, stopLossAtrMult: number, positionSizePct: number): Policy {
  return {
    ...policy,
    risk: { ...policy.risk, stopLossAtrMult, positionSizePct },
    strategy: { ...policy.strategy, compositeMin },
  };
}

function addYears(dateStr: string, years: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const end = new Date().toISOString().slice(0, 10);
  const holdoutStart = addYears(end, -HOLDOUT_YEARS);
  const trainEnd = addDays(holdoutStart, -1);
  const basePolicy = getPolicy();

  const grid: Array<{ exitMode: ExitMode; compositeMin: number; stopLossAtrMult: number; positionSizePct: number }> = [];
  for (const exitMode of EXIT_MODES) {
    for (const compositeMin of COMPOSITE_MIN_GRID) {
      for (const stopLossAtrMult of STOP_LOSS_ATR_MULT_GRID) {
        for (const positionSizePct of POSITION_SIZE_PCT_GRID) {
          grid.push({ exitMode, compositeMin, stopLossAtrMult, positionSizePct });
        }
      }
    }
  }

  console.log(`Sweeping ${grid.length} grid point(s) x 2 splits (train ${START}..${trainEnd}, holdout ${holdoutStart}..${end})...`);

  const points: SweepPoint[] = [];
  for (const [i, g] of grid.entries()) {
    const policy = withOverrides(basePolicy, g.compositeMin, g.stopLossAtrMult, g.positionSizePct);

    const trainResult = await runBacktest({
      policy, exitMode: g.exitMode, start: START, end: trainEnd,
      slippagePct: SLIPPAGE_PCT, initialEquity: INITIAL_EQUITY, takeProfitRMult: TAKE_PROFIT_R_MULT,
    });
    const holdoutResult = await runBacktest({
      policy, exitMode: g.exitMode, start: holdoutStart, end,
      slippagePct: SLIPPAGE_PCT, initialEquity: INITIAL_EQUITY, takeProfitRMult: TAKE_PROFIT_R_MULT,
    });

    points.push({
      exitMode: g.exitMode,
      compositeMin: g.compositeMin,
      stopLossAtrMult: g.stopLossAtrMult,
      positionSizePct: g.positionSizePct,
      train: {
        scorecard: scorecard(trainResult.trades),
        benchmark: await benchmarkStats(trainResult.equityCurve, START, trainEnd),
      },
      holdout: {
        scorecard: scorecard(holdoutResult.trades),
        benchmark: await benchmarkStats(holdoutResult.equityCurve, holdoutStart, end),
      },
    });

    console.log(`  [${i + 1}/${grid.length}] ${g.exitMode} compositeMin=${g.compositeMin} stopAtrMult=${g.stopLossAtrMult} sizePct=${g.positionSizePct} — train ${trainResult.trades.length} trades, holdout ${holdoutResult.trades.length} trades`);
  }

  const report = renderSweepReport(points);
  ensureDataDir(OUT_DIR);
  const outFile = path.join(OUT_DIR, 'backtest-sweep.md');
  fs.writeFileSync(outFile, report, 'utf8');
  console.log(`\nReport written to ${outFile}`);
}

main().catch((err) => {
  console.error(`Backtest sweep failed: ${err.message}`);
  process.exit(1);
});
