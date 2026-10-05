import { newJobDirectory } from '../core/jobs';
/**
 * Compares signal families — `trend` (existing), `meanReversion`, `crossSectional`, and
 * `blend` (new, see `strategy/meanReversion.ts` and `strategy/crossSectional.ts`) — under the
 * same train/holdout split `backtestSweep.ts` uses. `exitMode` is fixed at `stop_only` (the
 * sweep's own reference mode) so this isolates signal family from exit mechanics; only
 * `signalSet` and `compositeMin` vary.
 *
 *   npm run backtest:signals
 */

import path from 'path';
import fs from 'fs';
import type { Policy } from '../policy/types';
import { getPolicy } from '../policy/load';
import { ensureDataDir } from '../core/paths';
import { runBacktest, type SignalSet } from '../backtest/engine';
import { scorecard } from '../backtest/metrics';
import { benchmarkStats } from '../backtest/benchmarkStats';
import { renderSignalFamilyReport, type SignalFamilyPoint } from '../backtest/report';

const START = '2016-01-01';
const HOLDOUT_YEARS = 2;
const SLIPPAGE_PCT = 0.0005;
const INITIAL_EQUITY = 100_000;
const TAKE_PROFIT_R_MULT = 2;
const OUT_DIR = newJobDirectory('backtestSignalFamilies');

const SIGNAL_SETS: SignalSet[] = ['trend', 'meanReversion', 'crossSectional', 'blend'];
const COMPOSITE_MIN_GRID = [0.1, 0.2, 0.3];

function withOverrides(policy: Policy, compositeMin: number): Policy {
  return { ...policy, strategy: { ...policy.strategy, compositeMin } };
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

  const grid: Array<{ signalSet: SignalSet; compositeMin: number }> = [];
  for (const signalSet of SIGNAL_SETS) {
    for (const compositeMin of COMPOSITE_MIN_GRID) {
      grid.push({ signalSet, compositeMin });
    }
  }

  console.log(`Comparing ${grid.length} grid point(s) x 2 splits (train ${START}..${trainEnd}, holdout ${holdoutStart}..${end})...`);

  const points: SignalFamilyPoint[] = [];
  for (const [i, g] of grid.entries()) {
    const policy = withOverrides(basePolicy, g.compositeMin);

    const trainResult = await runBacktest({
      policy, exitMode: 'stop_only', start: START, end: trainEnd,
      slippagePct: SLIPPAGE_PCT, initialEquity: INITIAL_EQUITY, takeProfitRMult: TAKE_PROFIT_R_MULT,
      signalSet: g.signalSet,
    });
    const holdoutResult = await runBacktest({
      policy, exitMode: 'stop_only', start: holdoutStart, end,
      slippagePct: SLIPPAGE_PCT, initialEquity: INITIAL_EQUITY, takeProfitRMult: TAKE_PROFIT_R_MULT,
      signalSet: g.signalSet,
    });

    points.push({
      signalSet: g.signalSet,
      compositeMin: g.compositeMin,
      train: {
        scorecard: scorecard(trainResult.trades),
        benchmark: await benchmarkStats(trainResult.equityCurve, START, trainEnd),
      },
      holdout: {
        scorecard: scorecard(holdoutResult.trades),
        benchmark: await benchmarkStats(holdoutResult.equityCurve, holdoutStart, end),
      },
    });

    console.log(`  [${i + 1}/${grid.length}] ${g.signalSet} compositeMin=${g.compositeMin} — train ${trainResult.trades.length} trades, holdout ${holdoutResult.trades.length} trades`);
  }

  const report = renderSignalFamilyReport(points);
  ensureDataDir(OUT_DIR);
  const outFile = path.join(OUT_DIR, 'backtest-signal-families.md');
  fs.writeFileSync(outFile, report, 'utf8');
  console.log(`\nReport written to ${outFile}`);
}

main().catch((err) => {
  console.error(`Backtest signal family comparison failed: ${err.message}`);
  process.exit(1);
});
