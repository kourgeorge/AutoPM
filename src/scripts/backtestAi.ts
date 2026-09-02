/**
 * The Level 1.5 backtest — same walk-forward engine as `npm run backtest`, but the AI (the same
 * model the live bot uses, via `config.ai`) decides entry/exit timing and its own stop-loss/
 * take-profit from the mechanical signals only. Still no news, no fundamentals, no regime. See
 * `/Users/georgekour/.claude/plans/adaptive-roaming-aurora.md` for the full design.
 *
 * `--start`/`--end` let the same script run either the small pilot window or the full 10-year
 * window — run the pilot first and verify it before trusting the full run.
 *
 *   npm run backtest:ai -- --start 2022-01-01 --end 2025-01-01   (pilot)
 *   npm run backtest:ai                                          (full range, 2016-01-01 to today)
 */

import path from 'path';
import fs from 'fs';
import { getPolicy } from '../policy/load';
import { ensureDataDir } from '../core/paths';
import { config } from '../core/config';
import { createModelProvider } from '../core/modelProvider';
import { runBacktest } from '../backtest/engine';
import { scorecard } from '../backtest/metrics';
import { benchmarkStats } from '../backtest/benchmarkStats';
import { renderBaselineReport } from '../backtest/report';

const DEFAULT_START = '2016-01-01';
const SLIPPAGE_PCT = 0.0005;
const INITIAL_EQUITY = 100_000;
const TAKE_PROFIT_R_MULT = 2;
const OUT_DIR = path.join(process.cwd(), 'backtest-results');

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const start = argValue('--start') ?? DEFAULT_START;
  const end = argValue('--end') ?? new Date().toISOString().slice(0, 10);
  const policy = getPolicy();
  const provider = createModelProvider(config.ai);

  console.log(`Running Level 1.5 (AI-decided) backtest: ${start} to ${end}, ${policy.strategy.watchlist.length} symbols, model ${config.ai.model}...`);

  const result = await runBacktest({
    policy,
    exitMode: 'stop_only',
    start,
    end,
    slippagePct: SLIPPAGE_PCT,
    initialEquity: INITIAL_EQUITY,
    takeProfitRMult: TAKE_PROFIT_R_MULT,
    ai: { aiConfig: config.ai, provider },
  });

  const sc = scorecard(result.trades);
  const bm = await benchmarkStats(result.equityCurve, start, end);
  const report = renderBaselineReport(
    { policy, exitMode: 'stop_only', start, end, slippagePct: SLIPPAGE_PCT, initialEquity: INITIAL_EQUITY, takeProfitRMult: TAKE_PROFIT_R_MULT },
    sc,
    bm,
    result.caveats,
    result.aiStats,
  );

  ensureDataDir(OUT_DIR);
  const outFile = path.join(OUT_DIR, `backtest-ai_${start}_${end}.md`);
  fs.writeFileSync(outFile, report, 'utf8');

  const logFile = path.join(OUT_DIR, `backtest-ai_${start}_${end}-decisions.json`);
  fs.writeFileSync(logFile, JSON.stringify(result.aiDecisionLog ?? [], null, 2), 'utf8');

  console.log(`\n${sc.trades} trades, ${sc.wins} wins / ${sc.losses} losses, expectancy ${sc.expectancyPct ?? '—'}%`);
  console.log(`AI calls: ${result.aiStats?.calls ?? 0} (${result.aiStats?.cacheHits ?? 0} from cache)`);
  console.log(`Final equity: $${result.finalEquity.toFixed(2)} (started $${INITIAL_EQUITY.toFixed(2)})`);
  console.log(`SPY over the same window: ${bm.spyReturnPct ?? '—'}% — excess ${bm.excessPct ?? '—'}%`);
  console.log(`\nReport written to ${outFile}`);
  console.log(`Decision log written to ${logFile}`);
}

main().catch((err) => {
  console.error(`Backtest failed: ${err.message}`);
  process.exit(1);
});
