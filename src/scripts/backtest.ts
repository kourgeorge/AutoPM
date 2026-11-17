import { newJobDirectory } from '../core/jobs';
/**
 * The Level 1 backtest baseline — the `stop_only` exit mode over the full 10-year range at
 * whatever `Policy` is currently live. This is the closest thing to "did the mechanical part
 * of the strategy make money," with no AI, no news, no fundamentals, and no regime sizing.
 * See `/Users/georgekour/.claude/plans/adaptive-roaming-aurora.md` (or `src/backtest/engine.ts`'s
 * header) for exactly what that leaves out and why.
 *
 * Needs Alpaca market-data credentials only. It also happens to need `AI_API_KEY` set in the
 * environment — not because it calls the AI, but because `src/core/alpacaHttp.ts` imports
 * `src/core/config.ts`, which requires that variable at import time unless `AI_PROVIDER=ollama`.
 * Any environment already running the live daemon has this set already.
 *
 * Runs twice: learning off (every weight 1, no learned signals) and the current learned set,
 * reported side by side. The main sections are the "off" run; the on-vs-off section marks the
 * part of the range the learned set was chosen on (see `backtest/learningCompare.ts`).
 *
 *   npm run backtest
 */

import path from 'path';
import fs from 'fs';
import { getPolicy } from '../policy/load';
import { ensureDataDir } from '../core/paths';
import { runBacktest } from '../backtest/engine';
import { scorecard } from '../backtest/metrics';
import { benchmarkStats } from '../backtest/benchmarkStats';
import { renderBaselineReport } from '../backtest/report';
import { LEARNING_OFF, liveSignalSetup } from '../signals/registry';
import { isLearningOff, renderLearningComparison, tunedThrough } from '../backtest/learningCompare';

const START = '2016-01-01';
const SLIPPAGE_PCT = 0.0005;
const INITIAL_EQUITY = 100_000;
const TAKE_PROFIT_R_MULT = 2;
const OUT_DIR = newJobDirectory('backtest');

async function main() {
  const end = new Date().toISOString().slice(0, 10);
  const policy = getPolicy();

  console.log(`Running stop_only baseline: ${START} to ${end}, ${policy.strategy.watchlist.length} symbols...`);

  const base = {
    policy,
    exitMode: 'stop_only' as const,
    start: START,
    end,
    slippagePct: SLIPPAGE_PCT,
    initialEquity: INITIAL_EQUITY,
    takeProfitRMult: TAKE_PROFIT_R_MULT,
  };
  const onSetup = liveSignalSetup();
  const result = await runBacktest({ ...base, learning: LEARNING_OFF });
  const onResult = isLearningOff(onSetup) ? null : await runBacktest({ ...base, learning: onSetup });

  const sc = scorecard(result.trades);
  const bm = await benchmarkStats(result.equityCurve, START, end);
  const report = renderBaselineReport(
    { policy, exitMode: 'stop_only', start: START, end, slippagePct: SLIPPAGE_PCT, initialEquity: INITIAL_EQUITY, takeProfitRMult: TAKE_PROFIT_R_MULT },
    sc,
    bm,
    result.caveats,
  ) + '\n' + renderLearningComparison({
    start: START, end, initialEquity: INITIAL_EQUITY, off: result, on: onResult, onSetup, tunedThrough: tunedThrough(onSetup),
  });

  ensureDataDir(OUT_DIR);
  const outFile = path.join(OUT_DIR, 'backtest-stop_only.md');
  fs.writeFileSync(outFile, report, 'utf8');

  console.log(`\nLearning off: ${sc.trades} trades, ${sc.wins} wins / ${sc.losses} losses, expectancy ${sc.expectancyPct ?? '—'}%`);
  console.log(`Final equity: $${result.finalEquity.toFixed(2)} (started $${INITIAL_EQUITY.toFixed(2)})`);
  console.log(`SPY over the same window: ${bm.spyReturnPct ?? '—'}% — excess ${bm.excessPct ?? '—'}%`);
  if (onResult) console.log(`Learning on: ${onResult.trades.length} trades, final equity $${onResult.finalEquity.toFixed(2)} (see the report for the out-of-sample part)`);
  console.log(`\nReport written to ${outFile}`);
}

main().catch((err) => {
  console.error(`Backtest failed: ${err.message}`);
  process.exit(1);
});
