// Pins what the backtest scorecard (src/backtest/metrics.ts) returns today, before it is merged
// with the live scorecard in src/review/metrics.ts. Every expected value below was produced by
// the current code and the headline ones were checked by hand (see the comments).
// scorecard() reads no clock, no files and no network: it is a pure function of its input.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-backtest-metrics-')),
  BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
  ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
});
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access in backtest metrics test'); };
require('node:http').request = denyNetwork;
require('node:https').request = denyNetwork;
global.fetch = denyNetwork;
const { scorecard } = require(root + '/src/backtest/metrics');

function trade(symbol, entryDay, exitDay, entryPrice, exitPrice, qty, intendedStop, atrAtEntry, returnPct, holdingDays, exitReason) {
  return {
    symbol, entryAt: `${entryDay}T14:30:00Z`, exitAt: `${exitDay}T20:00:00Z`,
    entryPrice, exitPrice, qty, intendedStop, atrAtEntry,
    grossPnL: (exitPrice - entryPrice) * qty, returnPct, holdingDays, exitReason,
  };
}

// Deliberately NOT in exit order: the drawdown and losing-streak loop must sort by exitAt.
// In this array order the realised curve would give a drawdown of 66 and a streak of 1.
const TRADES = [
  //     symbol  entry         exit          entry  exit   qty stop atr  ret%  days  reason
  trade('AAPL', '2026-01-02', '2026-01-07', 100,   110,   10, 95,  2.5, 10,   5,  'take_profit'), // +100, R = 2
  trade('MSFT', '2026-01-06', '2026-01-09', 200,   188,   5,  190, 5,   -6,   3,  'stop'),        // -60, stop breached by 2/190 = 1.05%
  trade('MSFT', '2026-01-15', '2026-01-19', 190,   199.5, 2,  185, 4,   5,    4,  'take_profit'), // +19, R = 1.9
  trade('NVDA', '2026-01-08', '2026-01-12', 50,    47.5,  10, 48,  1,   -5,   2,  'ai_exit'),     // -25, below the stop but NOT a stop exit
  trade('AAPL', '2026-01-12', '2026-01-13', 105,   105,   4,  100, 2,   0,    1,  'ai_exit'),     // scratch
  trade('NVDA', '2026-01-14', '2026-01-30', 40,    46,    25, 0,   0,   15,   12, 'end_of_data'), // +150, no stop -> left out of R
];

test('backtest scorecard over mixed trades matches the pinned output', () => {
  assert.deepEqual(scorecard(TRADES), {
    window: { from: '2026-01-02T14:30:00Z', to: '2026-01-30T20:00:00Z' },
    trades: 6,
    wins: 3,
    losses: 2,
    scratches: 1,
    winRate: 50,
    grossPnL: 184,                 // 100 - 60 + 19 - 25 + 0 + 150
    avgWin: 89.67,                 // 269 / 3
    avgLoss: -42.5,                // -85 / 2
    profitFactor: 3.16,            // 269 / 85
    expectancy: 30.67,             // 184 / 6
    expectancyPct: 3.17,           // 19 / 6
    expectancyR: 0.29,             // (2 - 1.2 + 1.9 - 1.25 + 0) / 5
    expectancyRSample: 5,
    returnPctStdev: 8.38,          // sqrt(350.83 / 5)
    perTradeSharpe: 0.378,         // 3.1667 / 8.377
    perTradeSharpeR: 0.182,
    expectancyTStat: 0.93,         // 0.378 * sqrt(6)
    best: { symbol: 'NVDA', exitAt: '2026-01-30T20:00:00Z', grossPnL: 150, returnPct: 15, holdingDays: 12 },
    worst: { symbol: 'MSFT', exitAt: '2026-01-09T20:00:00Z', grossPnL: -60, returnPct: -6, holdingDays: 3 },
    avgHoldDays: 4.5,              // 27 / 6
    medianHoldDays: 3.5,           // (3 + 4) / 2
    avgHoldWinnersDays: 7,         // (5 + 4 + 12) / 3
    avgHoldLosersDays: 2.5,        // (3 + 2) / 2
    maxDrawdown: 85,               // in exit order: 100 peak -> 40 -> 15
    maxConsecutiveLosses: 2,       // MSFT stop then NVDA ai_exit; the scratch ends the streak
    stopDiscipline: {
      breached: 1,                 // only the 'stop' exit counts; the NVDA ai_exit below its stop does not
      worstBreachPct: 1.05,
      avgStopDistancePct: 4.28,    // (5 + 5 + 2.63 + 4 + 4.76) / 5
      avgStopAtrMultiple: 1.95,    // (2 + 2 + 1.25 + 2 + 2.5) / 5
    },
    bySymbol: {
      AAPL: { trades: 2, grossPnL: 100, winRate: 50, expectancy: 50 },
      MSFT: { trades: 2, grossPnL: -41, winRate: 50, expectancy: -20.5 },
      NVDA: { trades: 2, grossPnL: 125, winRate: 50, expectancy: 62.5 },
    },
    byExitReason: {
      take_profit: { trades: 2, grossPnL: 119, winRate: 100, expectancy: 59.5 },
      stop: { trades: 1, grossPnL: -60, winRate: 0, expectancy: -60 },
      ai_exit: { trades: 2, grossPnL: -25, winRate: 0, expectancy: -12.5 },
      end_of_data: { trades: 1, grossPnL: 150, winRate: 100, expectancy: 150 },
    },
    caveats: [
      '6 simulated trade(s) — too few for the win rate or expectancy to distinguish skill from variance.',
      'expectancyR covers 5 of 6 trade(s); the rest had no usable stop distance (entry at or below the stop).',
      '1 trade(s) were still open at the end of the data range and were closed at their last known price — not a real exit, included in P&L regardless.',
      'These are trade-shape statistics only, not compared to a benchmark — see the benchmark section of the report for the equity curve against real SPY.',
      'perTradeSharpe and expectancyTStat are computed over 6 trade(s) — at this sample size the standard deviation is itself an estimate.',
    ],
  });
});

test('backtest scorecard groups are ordered by trade count, largest first', () => {
  // deepEqual ignores key order, so pin the order separately. Ties keep first-seen order.
  const card = scorecard(TRADES);
  assert.deepEqual(Object.keys(card.byExitReason), ['take_profit', 'ai_exit', 'stop', 'end_of_data']);
  assert.deepEqual(Object.keys(card.bySymbol), ['AAPL', 'MSFT', 'NVDA']);
});

test('backtest scorecard of no trades is the pinned empty card', () => {
  assert.deepEqual(scorecard([]), {
    window: { from: null, to: null },
    trades: 0, wins: 0, losses: 0, scratches: 0, winRate: null,
    grossPnL: 0,
    avgWin: null, avgLoss: null, profitFactor: null, expectancy: null, expectancyPct: null,
    expectancyR: null, expectancyRSample: 0,
    returnPctStdev: null, perTradeSharpe: null, perTradeSharpeR: null, expectancyTStat: null,
    best: null, worst: null,
    avgHoldDays: null, medianHoldDays: null, avgHoldWinnersDays: null, avgHoldLosersDays: null,
    maxDrawdown: 0, maxConsecutiveLosses: 0,
    stopDiscipline: { breached: 0, worstBreachPct: null, avgStopDistancePct: null, avgStopAtrMultiple: null },
    bySymbol: {}, byExitReason: {},
    caveats: ['No simulated trades in this run — nothing here is measurable.'],
  });
});

test('backtest scorecard of identical-return wins gives null dispersion figures, not infinity', () => {
  const same = [
    trade('SPY', '2026-02-02', '2026-02-04', 100, 102, 10, 98, 1, 2, 2, 'take_profit'),
    trade('SPY', '2026-02-05', '2026-02-09', 100, 102, 10, 98, 1, 2, 4, 'take_profit'),
  ];
  assert.deepEqual(scorecard(same), {
    window: { from: '2026-02-02T14:30:00Z', to: '2026-02-09T20:00:00Z' },
    trades: 2, wins: 2, losses: 0, scratches: 0, winRate: 100,
    grossPnL: 40,
    avgWin: 20, avgLoss: null, profitFactor: null, expectancy: 20, expectancyPct: 2,
    expectancyR: 1, expectancyRSample: 2,
    returnPctStdev: 0, perTradeSharpe: null, perTradeSharpeR: null, expectancyTStat: null,
    best: { symbol: 'SPY', exitAt: '2026-02-04T20:00:00Z', grossPnL: 20, returnPct: 2, holdingDays: 2 },
    worst: { symbol: 'SPY', exitAt: '2026-02-04T20:00:00Z', grossPnL: 20, returnPct: 2, holdingDays: 2 },
    avgHoldDays: 3, medianHoldDays: 3, avgHoldWinnersDays: 3, avgHoldLosersDays: null,
    maxDrawdown: 0, maxConsecutiveLosses: 0,
    stopDiscipline: { breached: 0, worstBreachPct: null, avgStopDistancePct: 2, avgStopAtrMultiple: 2 },
    bySymbol: { SPY: { trades: 2, grossPnL: 40, winRate: 100, expectancy: 20 } },
    byExitReason: { take_profit: { trades: 2, grossPnL: 40, winRate: 100, expectancy: 20 } },
    caveats: [
      '2 simulated trade(s) — too few for the win rate or expectancy to distinguish skill from variance.',
      'These are trade-shape statistics only, not compared to a benchmark — see the benchmark section of the report for the equity curve against real SPY.',
      'perTradeSharpe and expectancyTStat are computed over 2 trade(s) — at this sample size the standard deviation is itself an estimate.',
      'Every trade returned exactly the same percentage, so the dispersion figures are null rather than infinite.',
    ],
  });
});

// T-66: both scorecards share tradeShape() and pass in their own rules. Same rows, two rules:
// the NVDA ai_exit below its stop is a breach under the live rule and not under the backtest one;
// the drawdown walk follows array order unless sortByExit is set.
test('tradeShape applies the breach, hold and exit-order rules it is given', () => {
  const { tradeShape } = require(root + '/src/review/metrics');
  const backtestRule = tradeShape(TRADES, {
    breached: (t, stop) => t.exitReason === 'stop' && t.exitPrice < stop,
    hold: t => t.holdingDays, sortByExit: true,
  });
  const liveRule = tradeShape(TRADES, { breached: (t, stop) => t.exitPrice < stop, hold: t => t.holdingDays * 24 });
  assert.deepEqual(backtestRule.stops, { measurable: 5, breached: 1, worstBreachPct: 1.05, avgStopDistancePct: 4.28, avgStopAtrMultiple: 1.95 });
  assert.equal(liveRule.stops.breached, 2);
  assert.equal(liveRule.stops.worstBreachPct, 1.05);
  assert.equal(backtestRule.hold.avg, 4.5);
  assert.equal(liveRule.hold.avg, 108);
  assert.deepEqual(backtestRule.drawdown, { maxDrawdown: 85, maxConsecutiveLosses: 2 });
  assert.deepEqual(liveRule.drawdown, { maxDrawdown: 66, maxConsecutiveLosses: 1 });
  assert.equal(backtestRule.best, TRADES[5]);
  assert.equal(backtestRule.worst, TRADES[1]);
});
