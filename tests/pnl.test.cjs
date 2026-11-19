const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-pnl-')),
  BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
  ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test',
  ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
});
require(root + '/node_modules/ts-node/register');
const { pnlReport } = require(root + '/src/review/pnl');

let n = 0;
const fill = (side, qty, price, at, extra = {}) =>
  ({ execId: 'e' + (++n), brokerOrderId: 'o' + n, permId: null, symbol: 'AAA', side, qty, price, fee: null, at, ...extra });
const held = qty => [{ symbol: 'AAA', qty, avgCost: 0, marketValue: 0, unrealizedPnL: 0 }];
const aaa = report => report.bySymbol.find(r => r.symbol === 'AAA');

// buy 10 @ 100, sell 4 @ 110 (+40 at avg 100), buy 4 @ 120 (avg becomes (600+480)/10 = 108)
const opening = () => [
  fill('buy', 10, 100, '2026-09-01T14:00:00Z'),
  fill('sell', 4, 110, '2026-09-02T14:00:00Z'),
  fill('buy', 4, 120, '2026-09-03T14:00:00Z'),
];

test('full exit after a partial sell and an add realizes the average-cost total and closes the position', () => {
  const r = pnlReport([...opening(), fill('sell', 10, 125, '2026-09-04T14:00:00Z')], []);
  const row = aaa(r);
  // 40 + 10 x (125 - 108) = 210
  assert.deepEqual([row.realizedPnL, row.realizedThisPosition, row.ledgerQty, row.heldQty], [210, 0, 0, null]);
  assert.deepEqual([row.sharesBought, row.sharesSold, row.unmatchedQty], [14, 14, 0]);
  assert.equal(r.realizedPnL, 210);
  assert.equal(r.realizedOnOpenPositions, 0);
});

test('a partial sell after an add is matched on average cost, not first-in-first-out', () => {
  const r = pnlReport([...opening(), fill('sell', 6, 125, '2026-09-04T14:00:00Z')], held(4));
  const row = aaa(r);
  // average cost: 40 + 6 x (125 - 108) = 142; FIFO would give 40 + 6 x (125 - 100) = 190
  assert.deepEqual([row.realizedPnL, row.realizedThisPosition, row.ledgerQty, row.heldQty], [142, 142, 4, 4]);
  assert.equal(r.realizedOnOpenPositions, 142);
});

test('a partial sell on a still-held position shows in realizedThisPosition', () => {
  const r = pnlReport(opening(), held(10));
  const row = aaa(r);
  assert.deepEqual([row.realizedPnL, row.realizedThisPosition, row.ledgerQty, row.heldQty], [40, 40, 10, 10]);
});

test('realizedThisPosition is 0 when the broker no longer holds the stock', () => {
  const row = aaa(pnlReport(opening(), []));
  assert.equal(row.realizedPnL, 40);
  assert.equal(row.realizedThisPosition, 0);
  assert.equal(row.heldQty, null);
});

test('a sell with no prior buy adds nothing to realized and counts as unmatched', () => {
  const r = pnlReport([fill('sell', 5, 50, '2026-09-01T14:00:00Z')], []);
  const row = aaa(r);
  assert.deepEqual([row.realizedPnL, row.unmatchedQty, row.sharesSold, row.ledgerQty], [0, 5, 5, 0]);
  assert.equal(r.realizedPnL, 0);
  assert.ok(r.caveats.some(c => /no recorded buy/.test(c)));
});

test('a sell larger than the recorded buys counts only the matched shares', () => {
  const row = aaa(pnlReport([fill('buy', 3, 10, '2026-09-01T14:00:00Z'), fill('sell', 5, 12, '2026-09-02T14:00:00Z')], []));
  assert.deepEqual([row.realizedPnL, row.unmatchedQty, row.ledgerQty], [6, 2, 0]);
});

test('since window counts only later sells but keeps the cost basis from all buys', () => {
  const fills = [...opening(), fill('sell', 6, 125, '2026-09-04T14:00:00Z')];
  const r = pnlReport(fills, held(4), { since: new Date('2026-09-02T20:00:00Z') });
  const row = aaa(r);
  // only the second sell: 6 x (125 - 108) = 102; a basis from in-window buys only would be 6 x 5 = 30
  assert.equal(row.realizedPnL, 102);
  assert.equal(r.realizedPnL, 102);
  assert.deepEqual([row.sharesBought, row.sharesSold, row.ledgerQty], [4, 6, 4]);
  assert.equal(r.window.fills, 2);
  assert.equal(r.window.since, '2026-09-02T20:00:00.000Z');
});

test('fills are matched in time order even when given out of order', () => {
  const [b1, s1, b2] = opening();
  const row = aaa(pnlReport([b2, fill('sell', 6, 125, '2026-09-04T14:00:00Z'), s1, b1], held(4)));
  assert.equal(row.realizedPnL, 142);
});

test('fees are summed over the fills in the window and left out of profit', () => {
  const fills = [
    fill('buy', 10, 100, '2026-09-01T14:00:00Z', { fee: 1 }),
    fill('sell', 4, 110, '2026-09-02T14:00:00Z', { fee: 0.25 }),
    fill('buy', 4, 120, '2026-09-03T14:00:00Z'),
    fill('sell', 6, 125, '2026-09-04T14:00:00Z', { fee: 0.5 }),
  ];
  const all = aaa(pnlReport(fills, held(4)));
  assert.equal(all.fees, 1.75);
  assert.equal(all.realizedPnL, 142);
  const windowed = aaa(pnlReport(fills, held(4), { since: new Date('2026-09-02T20:00:00Z') }));
  assert.equal(windowed.fees, 0.5);
});

test('fees are null when no fill reported one', () => {
  assert.equal(aaa(pnlReport(opening(), held(10))).fees, null);
});

test('an empty ledger with nothing held gives an all-zero report', () => {
  const r = pnlReport([], []);
  assert.deepEqual([r.realizedPnL, r.unrealizedPnL, r.totalPnL, r.bySymbol.length, r.window.fills], [0, 0, 0, 0, 0]);
});

test('fills with zero quantity or a non-number price are ignored', () => {
  const row = aaa(pnlReport([...opening(), fill('sell', 0, 125, '2026-09-04T14:00:00Z'), fill('sell', 2, NaN, '2026-09-05T14:00:00Z')], held(10)));
  assert.deepEqual([row.realizedPnL, row.ledgerQty, row.sharesSold], [40, 10, 4]);
});
