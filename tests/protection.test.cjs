// The operator's stop relink and re-arm (src/strategy/protectionIntent.ts):
// confirmProtection links a broker order as "our stop" only when it matches what we meant to
// place; clearUnplacedProtection drops an uncertain request only when the broker shows nothing.
// The broker is stubbed, so nothing here reaches the network.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-protection-'));
Object.assign(process.env, { DATA_DIR: dir, BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test', ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets' });
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access'); };
require('http').request = denyNetwork;
require('https').request = denyNetwork;
global.fetch = denyNetwork;
const state = require('../src/state/state');
const store = require('../src/core/storage');
const runtime = require('../src/core/runtime');
const { broker } = require('../src/broker');
const protection = require('../src/strategy/protectionIntent');

let held, openOrders;
const stopOrder = (extra = {}) => ({ id: 'stop-1', symbol: 'AAPL', side: 'sell', type: 'stop', qty: 10, filled: 0, stopPrice: 95, ...extra });
const targetOrder = (extra = {}) => ({ id: 'tp-1', symbol: 'AAPL', side: 'sell', type: 'limit', qty: 10, filled: 0, limitPrice: 120, ...extra });
const setIntent = (extra = {}) => store.saveValue('protectionIntents', {
  AAPL: { id: 'atp-test', symbol: 'AAPL', at: '2026-11-20T15:00:00.000Z', stop: 95, status: 'unknown', error: 'timeout', ...extra },
});
const snapshot = () => JSON.parse(JSON.stringify(state.getState().positionSnapshots.AAPL));
const intent = () => protection.protectionIntents().AAPL;

beforeEach(async () => {
  store.resetStorage();
  state.updateState({ positionSnapshots: {}, accountId: 'alpaca:paper:acct', paused: false, dailyLossHalted: false, startOfDayEquity: 100000 });
  held = [{ symbol: 'AAPL', qty: 10, avgCost: 100, marketValue: 1000 }];
  openOrders = [];
  broker.getAccountInfo = async () => ({ accountId: 'acct', equity: 100000, cash: 100000, buyingPower: 100000, previousCloseEquity: 100000 });
  broker.getPositions = async () => held;
  broker.getOpenOrders = async () => openOrders;
  await runtime.initializeAccount();
  state.openPositionSnapshot({ symbol: 'AAPL', entryPrice: 100, stopLevel: 90, stopOrderId: 'old-stop' });
  setIntent();
});
after(() => { runtime.stopRuntime(); store.closeStorage(); });

test('confirmProtection links a broker stop that matches the intended price and held shares', async () => {
  openOrders = [stopOrder()];
  await protection.confirmProtection('AAPL', 'stop-1', undefined, 'operator');
  const snap = snapshot();
  assert.equal(snap.stopOrderId, 'stop-1');
  assert.equal(snap.stopLevel, 95);
  assert.equal(intent().status, 'confirmed');
  assert.equal(intent().error, undefined);
});

test('confirmProtection leaves trading paused when it was paused', async () => {
  state.updateState({ paused: true });
  openOrders = [stopOrder()];
  await protection.confirmProtection('AAPL', 'stop-1', undefined, 'operator');
  assert.equal(state.getState().paused, true);
});

test('confirmProtection leaves trading running when it was not paused', async () => {
  openOrders = [stopOrder()];
  await protection.confirmProtection('AAPL', 'stop-1', undefined, 'operator');
  assert.equal(state.getState().paused, false);
});

test('confirmProtection links a stop and target that form a linked broker pair', async () => {
  setIntent({ target: 120 });
  openOrders = [stopOrder({ groupId: 'g1' }), targetOrder({ groupId: 'g1' })];
  await protection.confirmProtection('AAPL', 'stop-1', 'tp-1', 'operator');
  const snap = snapshot();
  assert.equal(snap.stopOrderId, 'stop-1');
  assert.equal(snap.takeProfitOrderId, 'tp-1');
  assert.equal(snap.takeProfitLevel, 120);
});

// Each refusal: the position record and the intent must be exactly as before.
async function assertRefused(args, pattern) {
  const before = snapshot();
  await assert.rejects(protection.confirmProtection(...args), pattern);
  assert.deepEqual(snapshot(), before);
  assert.equal(intent().status, 'unknown');
}

test('confirmProtection refuses a stop at a different price than intended', async () => {
  openOrders = [stopOrder({ stopPrice: 94 })];
  await assertRefused(['AAPL', 'stop-1', undefined, 'operator'], /does not match the intended price and held quantity/);
});

test('confirmProtection refuses a stop for fewer shares than are held', async () => {
  openOrders = [stopOrder({ qty: 9 })];
  await assertRefused(['AAPL', 'stop-1', undefined, 'operator'], /does not match the intended price and held quantity/);
});

test('confirmProtection refuses a stop whose unfilled shares no longer cover the holding', async () => {
  openOrders = [stopOrder({ filled: 1 })];
  await assertRefused(['AAPL', 'stop-1', undefined, 'operator'], /does not match the intended price and held quantity/);
});

test('confirmProtection refuses a stop for more shares than are held', async () => {
  openOrders = [stopOrder({ qty: 11 })];
  await assertRefused(['AAPL', 'stop-1', undefined, 'operator'], /does not match the intended price and held quantity/);
});

test('confirmProtection refuses a stop id the broker does not show', async () => {
  openOrders = [stopOrder()];
  await assertRefused(['AAPL', 'missing', undefined, 'operator'], /does not match/);
});

test('confirmProtection refuses an order for another symbol', async () => {
  openOrders = [stopOrder({ symbol: 'MSFT' })];
  await assertRefused(['AAPL', 'stop-1', undefined, 'operator'], /does not match/);
});

test('confirmProtection refuses a buy order as the stop', async () => {
  openOrders = [stopOrder({ side: 'buy' })];
  await assertRefused(['AAPL', 'stop-1', undefined, 'operator'], /does not match/);
});

test('confirmProtection refuses a target that is not part of a linked pair (no groupId)', async () => {
  setIntent({ target: 120 });
  openOrders = [stopOrder(), targetOrder()];
  await assertRefused(['AAPL', 'stop-1', 'tp-1', 'operator'], /linked broker pair/);
});

test('confirmProtection refuses a stop and target from different broker groups', async () => {
  setIntent({ target: 120 });
  openOrders = [stopOrder({ groupId: 'g1' }), targetOrder({ groupId: 'g2' })];
  await assertRefused(['AAPL', 'stop-1', 'tp-1', 'operator'], /linked broker pair/);
});

test('confirmProtection refuses a missing target when the intent had one', async () => {
  setIntent({ target: 120 });
  openOrders = [stopOrder({ groupId: 'g1' })];
  await assertRefused(['AAPL', 'stop-1', undefined, 'operator'], /Broker target does not match/);
});

test('confirmProtection refuses a target at a different price than intended', async () => {
  setIntent({ target: 120 });
  openOrders = [stopOrder({ groupId: 'g1' }), targetOrder({ groupId: 'g1', limitPrice: 121 })];
  await assertRefused(['AAPL', 'stop-1', 'tp-1', 'operator'], /Broker target does not match/);
});

test('confirmProtection refuses when the broker shows no shares held', async () => {
  held = [];
  openOrders = [stopOrder()];
  await assertRefused(['AAPL', 'stop-1', undefined, 'operator'], /Managed holding is unavailable/);
});

test('confirmProtection refuses when there is no interrupted request', async () => {
  store.saveValue('protectionIntents', {});
  openOrders = [stopOrder()];
  const before = snapshot();
  await assert.rejects(protection.confirmProtection('AAPL', 'stop-1', undefined, 'operator'), /No interrupted protection request/);
  assert.deepEqual(snapshot(), before);
});

test('confirmProtection refuses an already confirmed request', async () => {
  setIntent({ status: 'confirmed' });
  openOrders = [stopOrder()];
  const before = snapshot();
  await assert.rejects(protection.confirmProtection('AAPL', 'stop-1', undefined, 'operator'), /No interrupted protection request/);
  assert.deepEqual(snapshot(), before);
});

test('clearUnplacedProtection refuses while the broker shows any open order for the symbol', async () => {
  openOrders = [{ id: 'other', symbol: 'AAPL', side: 'buy', type: 'limit', qty: 1, filled: 0, limitPrice: 99 }];
  const before = snapshot();
  await assert.rejects(protection.clearUnplacedProtection('AAPL', 'operator'), /broker shows open orders for AAPL/);
  assert.deepEqual(snapshot(), before);
  assert.equal(intent().id, 'atp-test');
});

test('clearUnplacedProtection drops the intent and clears the stop order id when the broker shows none', async () => {
  openOrders = [stopOrder({ symbol: 'MSFT' })];
  await protection.clearUnplacedProtection('AAPL', 'operator');
  assert.equal(intent(), undefined);
  const snap = snapshot();
  assert.equal(snap.stopOrderId, undefined);
  assert.equal(snap.takeProfitOrderId, undefined);
  assert.equal(snap.stopLevel, 90);
});

test('clearUnplacedProtection refuses when there is no uncertain request', async () => {
  store.saveValue('protectionIntents', {});
  await assert.rejects(protection.clearUnplacedProtection('AAPL', 'operator'), /No uncertain protection request for AAPL/);
  assert.equal(snapshot().stopOrderId, 'old-stop');
});

test('clearUnplacedProtection refuses a confirmed request', async () => {
  setIntent({ status: 'confirmed' });
  await assert.rejects(protection.clearUnplacedProtection('AAPL', 'operator'), /No uncertain protection request for AAPL/);
  assert.equal(intent().status, 'confirmed');
  assert.equal(snapshot().stopOrderId, 'old-stop');
});
