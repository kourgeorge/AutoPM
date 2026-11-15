// The machine trailing stop's guards and failure rollback (src/strategy/trailingStop.ts).
// moveStopTo / moveOcoTo are stubbed, so nothing here reaches a broker or the network.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, afterEach, after } = require('node:test');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-trail-'));
Object.assign(process.env, { DATA_DIR: dir, BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test', ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets' });
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access'); };
require('http').request = denyNetwork;
require('https').request = denyNetwork;
global.fetch = denyNetwork;
const state = require('../src/state/state');
const store = require('../src/core/storage');
const policy = require('../src/policy/load');
const actions = require('../src/core/orders');
const stopOrders = require('../src/strategy/stopOrders');
const trail = require('../src/strategy/trailingStop');
const { broker } = require('../src/broker');
const runtime = require('../src/core/runtime');

const realMoveStopTo = stopOrders.moveStopTo;
const realMoveOcoTo = stopOrders.moveOcoTo;
let stopCalls, ocoCalls, moveResult;

function usePolicy(risk = {}, automation = {}) {
  policy.loadPolicy();
  const p = policy.getPolicy();
  policy.useEphemeralPolicy({ ...p, risk: { ...p.risk, ...risk }, automation: { ...p.automation, level: { ...p.automation.level, ...automation } } });
}

// Snapshot stop 100, session high 120, ATR 2, mult 2 → the trail aims for 116.
const position = (extra = {}) => ({ symbol: 'AAPL', qty: 10, price: 118, stale: false, sessionHigh: 120, atr: 2, ...extra });
const tick = (extra = {}) => ({ positions: { AAPL: position() }, ...extra });
const run = (data = tick()) => trail.trailStops(data, policy.getPolicy());

beforeEach(async () => {
  store.resetStorage();
  usePolicy({ trailingStopAtrMult: 2 }, { stopAdjust: 'auto' });
  state.updateState({ positionSnapshots: {}, accountId: 'alpaca:paper:acct', paused: false, dailyLossHalted: false, startOfDayEquity: 100000 });
  trail.resetTrailFailures();
  broker.marketSession = async () => 'regular';
  broker.getAccountInfo = async () => ({ accountId: 'acct', equity: 100000, cash: 100000, buyingPower: 100000, previousCloseEquity: 100000 });
  broker.getPositions = async () => [{ symbol: 'AAPL', qty: 10, avgCost: 100, marketValue: 1180 }];
  broker.getOpenOrders = async () => [];
  await runtime.initializeAccount();
  stopCalls = []; ocoCalls = [];
  moveResult = { ok: true, brokerOrderId: 'moved' };
  stopOrders.moveStopTo = async (...args) => { stopCalls.push(args); return moveResult; };
  stopOrders.moveOcoTo = async (...args) => { ocoCalls.push(args); return { ok: true, stopOrderId: 's', takeProfitOrderId: 't' }; };
  state.openPositionSnapshot({ symbol: 'AAPL', entryPrice: 100, stopLevel: 100, stopOrderId: 'our-stop' });
});
afterEach(() => { stopOrders.moveStopTo = realMoveStopTo; stopOrders.moveOcoTo = realMoveOcoTo; });
after(() => { runtime.stopRuntime(); store.closeStorage(); });

test('a tick moves the stop once, to 2 ATR below the session high', async () => {
  await run();
  assert.deepEqual(stopCalls, [['AAPL', 10, 116]]);
  assert.equal(ocoCalls.length, 0);
  assert.equal(state.getPositionSnapshot('AAPL').stopLevel, 116);
});

test('a position with a take-profit moves both legs together through moveOcoTo', async () => {
  state.upsertPositionSnapshot('AAPL', { takeProfitLevel: 130 });
  await run();
  assert.equal(stopCalls.length, 0);
  assert.deepEqual(ocoCalls, [['AAPL', 10, 116, 130]]);
});

test('nothing moves while trading is paused', async () => {
  state.updateState({ paused: true });
  await run();
  assert.equal(stopCalls.length, 0);
  assert.equal(state.getPositionSnapshot('AAPL').stopLevel, 100);
});

test('nothing moves while an order on the symbol is pending', async () => {
  actions.createOrder({ kind: 'exit', symbol: 'AAPL', venue: 'paper', params: { qty: 10 }, reason: 'selling', timeoutMs: 60000 });
  await run();
  assert.equal(stopCalls.length, 0);
});

test('nothing moves while another operation holds the stop lock', async () => {
  let release;
  const held = stopOrders.withStopLock('AAPL', () => new Promise(resolve => { release = resolve; }));
  try {
    assert.equal(stopOrders.isStopLocked('AAPL'), true);
    await run();
    assert.equal(stopCalls.length, 0);
  } finally { release(); await held; }
});

test('nothing moves while a protection request on the symbol is not confirmed', async () => {
  for (const status of ['pending', 'unknown']) {
    store.saveValue('protectionIntents', { AAPL: { id: 'p1', symbol: 'AAPL', at: new Date(0).toISOString(), stop: 100, status } });
    await run();
    assert.equal(stopCalls.length, 0, `intent status ${status}`);
  }
});

test('a confirmed protection request does not block the move', async () => {
  store.saveValue('protectionIntents', { AAPL: { id: 'p1', symbol: 'AAPL', at: new Date(0).toISOString(), stop: 100, status: 'confirmed' } });
  await run();
  assert.equal(stopCalls.length, 1);
});

test('a refused move puts the recorded stop back at 100', async () => {
  moveResult = { ok: false, reason: 'refused' };
  await run();
  assert.equal(stopCalls.length, 1);
  assert.equal(state.getPositionSnapshot('AAPL').stopLevel, 100);
});

test('a move that throws keeps the higher level for review and is not retried at once', async () => {
  stopOrders.moveStopTo = async (...args) => { stopCalls.push(args); throw new Error('socket hang up'); };
  await run();
  assert.equal(state.getPositionSnapshot('AAPL').stopLevel, 116);
  await run();
  assert.equal(stopCalls.length, 1);
});

test('the same failed target is not retried within 15 minutes, but is after', async () => {
  moveResult = { ok: false, reason: 'refused' };
  const realNow = Date.now;
  const start = Date.parse('2026-11-10T15:00:00Z');
  try {
    Date.now = () => start;
    await run();
    Date.now = () => start + trail.RETRY_AFTER_FAILURE_MS - 1000;
    await run();
    assert.equal(stopCalls.length, 1, 'retried inside the back-off');
    Date.now = () => start + trail.RETRY_AFTER_FAILURE_MS + 1000;
    await run();
    assert.equal(stopCalls.length, 2, 'not retried after the back-off');
  } finally { Date.now = realNow; }
});

test('a new target after a failure is tried at once', async () => {
  moveResult = { ok: false, reason: 'refused' };
  await run();
  await run(tick({ positions: { AAPL: position({ sessionHigh: 125, price: 123 }) } }));
  assert.deepEqual(stopCalls.map(c => c[2]), [116, 121]);
});

test('stale positions or stale orders give no plans and no move', async () => {
  for (const flag of ['positionsStale', 'ordersStale']) {
    assert.deepEqual(trail.trailPlans(tick({ [flag]: true }), policy.getPolicy()), [], flag);
    await run(tick({ [flag]: true }));
  }
  assert.equal(stopCalls.length, 0);
});

test('nothing moves unless stop adjustments are automatic', async () => {
  for (const level of ['manual', undefined]) {
    usePolicy({ trailingStopAtrMult: 2 }, { stopAdjust: level });
    assert.deepEqual(trail.trailPlans(tick(), policy.getPolicy()), [], level);
    await run();
  }
  assert.equal(stopCalls.length, 0);
});

test('nothing moves when the trail is off or the holding has no snapshot', async () => {
  usePolicy({ trailingStopAtrMult: null }, { stopAdjust: 'auto' });
  await run();
  usePolicy({ trailingStopAtrMult: 2 }, { stopAdjust: 'auto' });
  await run({ positions: { MSFT: { ...position(), symbol: 'MSFT' } } });
  assert.equal(stopCalls.length, 0);
});

test('fractional or zero quantities are skipped', () => {
  assert.deepEqual(trail.trailPlans({ positions: { AAPL: position({ qty: 2.5 }) } }, policy.getPolicy()), []);
  assert.deepEqual(trail.trailPlans({ positions: { AAPL: position({ qty: 0 }) } }, policy.getPolicy()), []);
});
