// The IBKR adapter's translation of TWS replies, with the IB client faked.
//
// `IBKRBroker` has no other coverage, and the edge that matters most is a fill TWS reports
// without a price: `e.price ?? 0` used to record a $0 buy, which the P&L matchers accept
// (they only reject a non-finite price) and turn into an enormous fake profit.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { test, beforeEach } = require('node:test');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-broker-ibkr-'));
Object.assign(process.env, {
  DATA_DIR: dir,
  BROKER: 'ibkr',
  HEADLESS: '1',
  AI_PROVIDER: 'ollama',
  AI_API_KEY: 'test',
  IBKR_ACCOUNT: 'DU1234567',
});

/** A tiny stand-in for `IBApiNext`: the streams the constructor subscribes to, plus the reads. */
class FakeIBApiNext {
  constructor(opts) {
    this.opts = opts;
    this.executionDetails = [];
    this.commissions = [];
    this.openOrders = [];
    FakeIBApiNext.instance = this;
  }
  connect() {}
  getOpenOrders() { return { subscribe: () => ({ unsubscribe() {} }) }; }
  getAccountUpdates() { return { subscribe: () => ({ unsubscribe() {} }) }; }
  get error() { return { subscribe: () => ({ unsubscribe() {} }) }; }
  getAllOpenOrders() { return Promise.resolve(this.openOrders); }
  getExecutionDetails() { return Promise.resolve(this.executionDetails); }
  getCommissionReport() { return Promise.resolve(this.commissions); }
}

// ts-node compiles the TS import to a CommonJS require, so intercepting the loader is enough;
// nothing reaches the real client or the network.
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@stoqey/ib') return { IBApiNext: FakeIBApiNext };
  return load.call(this, request, parent, isMain);
};

require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access'); };
require('http').request = denyNetwork;
require('https').request = denyNetwork;
global.fetch = denyNetwork;

const { recordFills } = require('../src/review/fills');
const { computeOutcomes } = require('../src/review/ledger');
// The adapter is loaded through the broker factory first: `IBKRBroker` imports `core/runtime`,
// which imports the factory, which constructs a broker — loading the class directly first
// makes that a circular import where the class is still half-initialised.
require('../src/broker');
const { IBKRBroker, mapIbOrder } = require('../src/broker/IBKRBroker');

const contract = { conId: 1, symbol: 'AAPL', secType: 'STK', currency: 'USD' };
const execution = (over = {}) => ({
  execId: '0000e0d5.01', orderId: 42, permId: 98765, side: 'BOT',
  shares: 10, price: 190.5, time: '20261127  15:30:00 US/Eastern', acctNumber: 'DU1234567',
  ...over,
});
const detail = over => ({ contract, execution: execution(over) });

const brokerWith = ({ details = [], commissions = [], orders = [] } = {}) => {
  const b = new IBKRBroker();
  const api = b.api;
  api.executionDetails = details;
  api.commissions = commissions;
  api.openOrders = orders;
  return b;
};

beforeEach(() => { /* each test builds its own broker and fake replies */ });

test('an execution without a price is dropped, so no $0 buy becomes a fake profit', async () => {
  const b = brokerWith({
    details: [
      detail({ execId: 'buy.01', side: 'BOT', shares: 10, price: undefined, time: '20261127  15:30:00 US/Eastern' }),
      detail({ execId: 'sell.01', side: 'SLD', shares: 10, price: 150, time: '20261127  15:35:00 US/Eastern' }),
    ],
  });

  const fills = await b.getFills();
  // The unpriced buy is not in the batch at all — not a fill carrying 0.
  assert.deepEqual(fills.map(f => f.execId), ['sell.01']);
  assert.ok(fills.every(f => f.price > 0));

  // And what reaches the round-trip matcher contains no trade: a sell against a missing buy
  // closes nothing. With the old `?? 0` fallback this was a $0 entry against a $150 exit,
  // i.e. $1500 of profit from a trade that never existed.
  recordFills(fills);
  const outcomes = computeOutcomes();
  assert.deepEqual(outcomes, []);
  assert.ok(!outcomes.some(o => o.entryPrice === 0 || o.grossPnL > 0));
});

test('a normal execution keeps its real price, side and fee', async () => {
  const b = brokerWith({
    details: [detail({ execId: '0000e0d5.01', orderId: 42, permId: 98765, side: 'SLD', shares: 5, price: 191.25 })],
    commissions: [{ execId: '0000e0d5.01', commission: 1.35 }],
  });

  const [fill] = await b.getFills();
  assert.equal(fill.execId, '0000e0d5.01');
  assert.equal(fill.symbol, 'AAPL');
  assert.equal(fill.side, 'sell');
  assert.equal(fill.qty, 5);
  assert.equal(fill.price, 191.25);
  assert.equal(fill.fee, 1.35);
  assert.equal(fill.brokerOrderId, '42');
  assert.equal(fill.permId, '98765');
  assert.equal(fill.at, '2026-11-27T20:30:00.000Z');
});

test('venue order types map by name rather than being coerced into limit', async () => {
  const order = (orderId, orderType, extra = {}) => ({
    orderId,
    contract,
    order: { account: 'DU1234567', action: 'SELL', totalQuantity: 2, orderType, ...extra },
    orderStatus: { status: 'Submitted', filled: 0 },
  });
  const b = brokerWith({ orders: [order(1, 'MKT'), order(2, 'STP LMT', { auxPrice: 95 }), order(3, 'TRAIL', { auxPrice: 5 })] });

  const parsed = await b.getOpenOrders();
  assert.deepEqual(parsed.map(o => [o.type, o.rawType]), [
    ['market', 'MKT'], ['stop_limit', 'STP LMT'], ['trailing_stop', 'TRAIL'],
  ]);
  assert.equal(parsed[1].stopPrice, 95);
  assert.equal(parsed[2].trailAmount, 5);
});

test('execution timestamps in US/Eastern parse with the DST offset', async () => {
  const b = brokerWith({
    details: [
      detail({ execId: 'winter.01', time: '20261127  15:30:00 US/Eastern' }),
      detail({ execId: 'summer.01', time: '20260715  15:30:00 US/Eastern' }),
    ],
  });

  const fills = await b.getFills();
  const at = Object.fromEntries(fills.map(f => [f.execId, f.at]));
  assert.equal(at['winter.01'], '2026-11-27T20:30:00.000Z');
  assert.equal(at['summer.01'], '2026-07-15T19:30:00.000Z');
});

// An order side the gateway spells in a way we do not know must never read as a sell: the stop
// sweep reserves shares against every sell order, so a buy misread as a sell leaves the position
// with no stop at the venue.
const sideOrder = (orderId, action) => ({
  orderId, contract,
  order: { account: 'DU1234567', action, orderType: 'LMT', lmtPrice: 100, totalQuantity: 10, orderRef: `ref-${orderId}` },
  orderStatus: { status: 'Submitted', filled: 0 },
});

test('mapIbOrder rejects a blank side instead of calling it a sell', () => {
  const r = mapIbOrder({ order: { action: '', orderType: 'STP', auxPrice: 95, totalQuantity: 10, account: 'DU1' }, contract: { symbol: 'AAPL' } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /side/);
  for (const action of [undefined, 'HOLD', 'SSHORT']) assert.equal(mapIbOrder(sideOrder(1, action)).ok, false);
});

test('mapIbOrder reads BUY/SELL and the execution spellings BOT/SLD', () => {
  const side = action => { const r = mapIbOrder(sideOrder(1, action)); assert.equal(r.ok, true); return r.order.side; };
  assert.equal(side('BUY'), 'buy');
  assert.equal(side('SELL'), 'sell');
  assert.equal(side('BOT'), 'buy');
  assert.equal(side('SLD'), 'sell');
  assert.equal(side('Buy'), 'buy');
});

test('getOpenOrders leaves out an order with an unknown side and keeps BOT as a buy', async () => {
  const b = brokerWith({ orders: [sideOrder(1, ''), sideOrder(2, 'BOT'), sideOrder(3, 'SELL')] });
  const parsed = await b.getOpenOrders();
  assert.deepEqual(parsed.map(o => [o.id, o.side]), [['2', 'buy'], ['3', 'sell']]);
});

test('getOrder/findOrder refuse an unknown side and read BOT as a buy', async () => {
  const b = brokerWith({ orders: [sideOrder(1, ''), sideOrder(2, 'BOT'), sideOrder(3, 'SLD')] });
  await assert.rejects(b.getOrder('1'), /unrecognised side/);
  await assert.rejects(b.findOrder('ref-1'), /unrecognised side/);
  assert.equal((await b.getOrder('2')).side, 'buy');
  assert.equal((await b.findOrder('ref-2')).side, 'buy');
  assert.equal((await b.getOrder('3')).side, 'sell');
});
