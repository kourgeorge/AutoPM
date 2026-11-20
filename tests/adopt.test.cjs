// adoptHolding's refusals and the snapshot it records (src/strategy/adopt.ts).
// The broker is stubbed and network access is denied, so nothing here reaches a real venue.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-adopt-'));
Object.assign(process.env, { DATA_DIR: dir, BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test', ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets' });
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access'); };
require('http').request = denyNetwork;
require('https').request = denyNetwork;
global.fetch = denyNetwork;
const state = require('../src/state/state');
const store = require('../src/core/storage');
const { broker } = require('../src/broker');
const runtime = require('../src/core/runtime');
const { adoptHolding, AdoptRefused } = require('../src/strategy/adopt');

// AAPL: 10 shares worth 1000, so the current price is $100; bought at $95.
const holding = (extra = {}) => ({ symbol: 'AAPL', qty: 10, avgCost: 95, marketValue: 1000, ...extra });
const adopt = (stop, target) => adoptHolding('AAPL', stop, target, 'tester');
const conflict = (pattern) => (err) => {
  assert.ok(err instanceof AdoptRefused, 'refused with AdoptRefused, got ' + err);
  assert.equal(err.kind, 'conflict');
  assert.match(err.message, pattern);
  return true;
};

beforeEach(async () => {
  store.resetStorage();
  state.updateState({ positionSnapshots: {}, accountId: 'alpaca:paper:acct', paused: false });
  broker.getAccountInfo = async () => ({ accountId: 'acct', equity: 100000, cash: 100000, buyingPower: 100000, previousCloseEquity: 100000 });
  broker.getPositions = async () => [holding()];
  broker.getOpenOrders = async () => [];
  await runtime.initializeAccount();
});
after(() => { runtime.stopRuntime(); store.closeStorage(); });

test('a stop above the current price is refused as a conflict', async () => {
  await assert.rejects(adopt(101), conflict(/Stop 101\.00 must be below the current price 100\.00/));
  assert.equal(state.getState().positionSnapshots.AAPL, undefined);
});

test('a target below the current price is refused as a conflict', async () => {
  await assert.rejects(adopt(90, 99), conflict(/Target 99\.00 must be above the current price 100\.00/));
  assert.equal(state.getState().positionSnapshots.AAPL, undefined);
});

test('a fractional holding is refused', async () => {
  broker.getPositions = async () => [holding({ qty: 10.5, marketValue: 1050 })];
  await assert.rejects(adopt(90), conflict(/fractional holding/));
});

test('a holding with no current price yet is refused', async () => {
  broker.getPositions = async () => [holding({ marketValue: undefined })];
  await assert.rejects(adopt(90), conflict(/has not reported a current price/));
});

test('a holding that is already managed is refused and its snapshot is left alone', async () => {
  state.openPositionSnapshot({ symbol: 'AAPL', entryPrice: 80, stopLevel: 70 });
  await assert.rejects(adopt(90), conflict(/already managed/));
  assert.equal(state.getState().positionSnapshots.AAPL.stopLevel, 70);
});

test('a holding with open orders already resting at the broker is refused', async () => {
  broker.getOpenOrders = async () => [{ symbol: 'AAPL', side: 'sell', type: 'limit', qty: 10, status: 'new' }];
  await assert.rejects(adopt(90), conflict(/Review existing broker orders/));
  assert.equal(state.getState().positionSnapshots.AAPL, undefined);
});

test('a valid adoption records the stop, target and average cost as the entry price', async () => {
  const result = await adopt(90, 110);
  assert.deepEqual(result, { symbol: 'AAPL', qty: 10, mark: 100 });
  const snap = state.getState().positionSnapshots.AAPL;
  assert.equal(snap.stopLevel, 90);
  assert.equal(snap.takeProfitLevel, 110);
  assert.equal(snap.entryPrice, 95);
});
