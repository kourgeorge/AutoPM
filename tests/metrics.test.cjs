const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-metrics-')),
  BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
  ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test',
  ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
});
require('ts-node/register');
const { scorecard } = require(root + '/src/review/metrics');
const { recordFills } = require(root + '/src/review/fills');
const journal = require(root + '/src/journal/journal');

// Each test uses its own symbol and reads `scorecard({ symbol })`, so the shared ledger
// in DATA_DIR never mixes cases.
let n = 0;
const fill = (symbol, side, qty, price, at, fee = null) =>
  ({ execId: 'e' + (++n), brokerOrderId: 'o' + n, permId: null, symbol, side, qty, price, fee, at });

/** One round trip: buy then sell, with an executed journal entry that declares the stop. */
function roundTrip(symbol, { qty, entry, stop, exit, day, fee = null }) {
  const buy = fill(symbol, 'buy', qty, entry, `2026-09-${day}T14:00:00Z`, fee);
  const sell = fill(symbol, 'sell', qty, exit, `2026-09-${day}T18:00:00Z`, fee);
  if (stop != null) {
    journal.recordDecision(journal.decision('entry', 'trader', {
      symbol, rationale: 'test entry', executed: true, qty, price: entry,
      intendedStop: stop, brokerOrderId: buy.brokerOrderId,
    }));
  }
  return [buy, sell];
}

// +$100 then -$50: 10 shares, entry 100, stop 95; exits at 110 and 95.
function seedWinThenLoss(symbol, fee = null) {
  recordFills([
    ...roundTrip(symbol, { qty: 10, entry: 100, stop: 95, exit: 110, day: '01', fee }),
    ...roundTrip(symbol, { qty: 10, entry: 100, stop: 95, exit: 95, day: '02', fee }),
  ]);
}

test('a +100 win and a -50 loss give the expected win rate, expectancy, profit factor and R', () => {
  seedWinThenLoss('WLA');
  const s = scorecard({ symbol: 'WLA' });
  assert.equal(s.trades, 2);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
  assert.equal(s.scratches, 0);
  assert.equal(s.winRate, 50);
  assert.equal(s.grossPnL, 50);
  assert.equal(s.expectancy, 25, 'expectancy is +25 per trade, not -25');
  assert.equal(s.profitFactor, 2);
  // R: +100 / (5 x 10) = 2, -50 / (5 x 10) = -1, mean 0.5
  assert.equal(s.expectancyR, 0.5);
  assert.equal(s.expectancyRSample, 2);
  assert.equal(s.avgWin, 100);
  assert.equal(s.avgLoss, -50);
  assert.equal(s.maxConsecutiveLosses, 1);
});

test('a -50 loss after a +100 win is a 50 drawdown from the realised peak and a losing streak of 1', () => {
  // The task brief said maxDrawdown 0; realised P&L runs 100 then 50, so peak-to-trough is 50.
  seedWinThenLoss('WLB');
  const s = scorecard({ symbol: 'WLB' });
  assert.equal(s.maxConsecutiveLosses, 1);
  assert.equal(s.maxDrawdown, 50);
});

test('fees on both trips are subtracted once from net, and gross figures stay gross', () => {
  seedWinThenLoss('FEE', 1); // $1 per fill, 4 fills = $4
  const s = scorecard({ symbol: 'FEE' });
  assert.equal(s.feesComplete, true);
  assert.equal(s.fees, 4);
  assert.equal(s.grossPnL, 50, 'gross P&L does not include fees');
  assert.equal(s.netPnL, 46, 'net = 50 - 4, the fee taken exactly once');
  assert.equal(s.expectancy, 25, 'expectancy is gross, so fees do not move it');
  assert.equal(s.profitFactor, 2);
});

test('a missing fee makes net P&L null instead of guessing', () => {
  recordFills([
    fill('PFE', 'buy', 10, 100, '2026-09-03T14:00:00Z', 1),
    fill('PFE', 'sell', 10, 110, '2026-09-03T18:00:00Z', null),
  ]);
  const s = scorecard({ symbol: 'PFE' });
  assert.equal(s.feesComplete, false);
  assert.equal(s.fees, 1);
  assert.equal(s.netPnL, null);
  assert.equal(s.grossPnL, 100);
});

test('a break-even trade is a scratch, not a win or a loss', () => {
  recordFills([
    ...roundTrip('SCR', { qty: 10, entry: 100, stop: 95, exit: 110, day: '04' }),
    ...roundTrip('SCR', { qty: 10, entry: 100, stop: 95, exit: 100, day: '05' }),
  ]);
  const s = scorecard({ symbol: 'SCR' });
  assert.equal(s.trades, 2);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 0);
  assert.equal(s.scratches, 1);
  assert.equal(s.winRate, 50, 'the scratch counts in the trade total but not as a win');
  assert.equal(s.profitFactor, null, 'no losses means profit factor is unmeasurable, not infinite');
  assert.equal(s.maxConsecutiveLosses, 0);
});

test('expectancyR covers only trips whose entry declared a stop', () => {
  recordFills([
    ...roundTrip('RRR', { qty: 10, entry: 100, stop: 95, exit: 110, day: '06' }),  // +2R
    ...roundTrip('RRR', { qty: 10, entry: 100, stop: null, exit: 90, day: '07' }), // no stop on record
  ]);
  const s = scorecard({ symbol: 'RRR' });
  assert.equal(s.expectancyRSample, 1);
  assert.equal(s.expectancyR, 2);
  assert.equal(s.expectancy, 0, '(+100 - 100) / 2');
  assert.ok(s.caveats.some(c => /expectancyR covers 1 of 2/.test(c)));
});

test('three losses in a row after a win give a streak of 3 and the full drawdown', () => {
  recordFills([
    ...roundTrip('STK', { qty: 10, entry: 100, stop: 95, exit: 110, day: '08' }), // +100
    ...roundTrip('STK', { qty: 10, entry: 100, stop: 95, exit: 95, day: '09' }),  // -50
    ...roundTrip('STK', { qty: 10, entry: 100, stop: 95, exit: 98, day: '10' }),  // -20
    ...roundTrip('STK', { qty: 10, entry: 100, stop: 95, exit: 97, day: '11' }),  // -30
  ]);
  const s = scorecard({ symbol: 'STK' });
  assert.equal(s.maxConsecutiveLosses, 3);
  assert.equal(s.maxDrawdown, 100);
  assert.equal(s.grossPnL, 0);
});

test('a symbol with no closed round trips returns the empty scorecard', () => {
  const s = scorecard({ symbol: 'NONE' });
  assert.equal(s.trades, 0);
  assert.equal(s.winRate, null);
  assert.equal(s.expectancy, null);
  assert.equal(s.profitFactor, null);
  assert.equal(s.expectancyR, null);
  assert.equal(s.maxDrawdown, 0);
});
