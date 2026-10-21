const assert = require('node:assert/strict');
const { test } = require('node:test');
require('ts-node/register');
const { brokerBook } = require('../src/review/brokerBook');

const stop = { id: 'stop-1', clientOrderId: 'x', groupId: 'g', symbol: 'WMT', side: 'sell', qty: 10, filled: 0, type: 'stop', rawType: 'stop', stopPrice: 95, tif: 'gtc', status: 'held' };
const target = { id: 'tp-1', clientOrderId: 'atp-abc', groupId: 'g', symbol: 'WMT', side: 'sell', qty: 10, filled: 0, type: 'limit', rawType: 'limit', limitPrice: 120, tif: 'gtc', status: 'new' };
const outside = { id: 'manual', symbol: 'AAPL', side: 'buy', qty: 1, filled: 0, type: 'limit', rawType: 'limit', limitPrice: 150, status: 'new' };
const position = { symbol: 'WMT', qty: 10, price: 100, stale: false, entryPrice: 100, pnlPct: 0 };

test('broker orders are joined to their holding, saved levels and the entry decision', () => {
  const book = brokerBook({ orders: [stop, target, outside], positions: [position],
    snapshots: { WMT: { symbol: 'WMT', stopLevel: 96, takeProfitLevel: 120, stopOrderId: 'stop-1', takeProfitOrderId: 'tp-1', entryDecisionId: 'd1' } },
    agentOrders: [], protection: {}, decision: id => id === 'd1' ? { id, at: 'now', rationale: 'Breakout', intendedStop: 96, intendedTarget: 120 } : undefined });
  const [s, t, o] = book.orders;
  assert.equal(s.role, 'stop'); assert.equal(t.role, 'target'); assert.equal(o.role, 'external');
  assert.equal(s.resultIfFilled, -50); assert.equal(t.resultIfFilled, 200);
  assert.equal(s.distancePct, 5); assert.equal(t.distancePct, -20);
  assert.equal(s.levelMismatch, true, 'a broker stop away from the saved level is flagged');
  assert.equal(s.pairedWith.id, 'tp-1');
  assert.equal(s.entryDecision.rationale, 'Breakout');
  assert.equal(o.position, null);
  assert.deepEqual(book.coverage[0], { symbol: 'WMT', qty: 10, managed: true, stopShares: 10, status: 'protected', recordedStop: 96, recordedTarget: 120, firstStop: 95 });
  assert.deepEqual(book.summary.mismatches, ['WMT']);
});

test('a holding with no stop at the broker is reported as unprotected', () => {
  const book = brokerBook({ orders: [target], positions: [position], snapshots: {}, agentOrders: [], protection: {}, decision: () => undefined });
  assert.equal(book.coverage[0].status, 'none'); assert.equal(book.coverage[0].firstStop, null);
  assert.deepEqual(book.summary.unprotected, ['WMT']);
  assert.equal(book.orders[0].role, 'protection', 'an atp- client id is this app\'s protection even without a saved snapshot');
});
