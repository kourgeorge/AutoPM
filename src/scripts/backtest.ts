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

const START = '2016-01-01';
const SLIPPAGE_PCT = 0.0005;
const INITIAL_EQUITY = 100_000;
const TAKE_PROFIT_R_MULT = 2;
const OUT_DIR = path.join(process.cwd(), 'backtest-results');

async function main() {
  const end = new Date().toISOString().slice(0, 10);
  const policy = getPolicy();

  console.log(`Running stop_only baseline: ${START} to ${end}, ${policy.strategy.watchlist.length} symbols...`);

  const result = await runBacktest({
    policy,
    exitMode: 'stop_only',
    start: START,
    end,
    slippagePct: SLIPPAGE_PCT,
    initialEquity: INITIAL_EQUITY,
    takeProfitRMult: TAKE_PROFIT_R_MULT,
  });

  const sc = scorecard(result.trades);
  const bm = await benchmarkStats(result.equityCurve, START, end);
  const report = renderBaselineReport(
    { policy, exitMode: 'stop_only', start: START, end, slippagePct: SLIPPAGE_PCT, initialEquity: INITIAL_EQUITY, takeProfitRMult: TAKE_PROFIT_R_MULT },
    sc,
    bm,
    result.caveats,
  );

  ensureDataDir(OUT_DIR);
  const outFile = path.join(OUT_DIR, 'backtest-stop_only.md');
  fs.writeFileSync(outFile, report, 'utf8');

  console.log(`\n${sc.trades} trades, ${sc.wins} wins / ${sc.losses} losses, expectancy ${sc.expectancyPct ?? '—'}%`);
  console.log(`Final equity: $${result.finalEquity.toFixed(2)} (started $${INITIAL_EQUITY.toFixed(2)})`);
  console.log(`SPY over the same window: ${bm.spyReturnPct ?? '—'}% — excess ${bm.excessPct ?? '—'}%`);
  console.log(`\nReport written to ${outFile}`);
}

main().catch((err) => {
  console.error(`Backtest failed: ${err.message}`);
  process.exit(1);
});
