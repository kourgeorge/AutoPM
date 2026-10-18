const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-ext-'));
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
const orders = require('../src/strategy/orderManager');
const prices = require('../src/collect/priceSource');
const bars = require('../src/collect/barSource');
const fundamentals = require('../src/collect/fundamentals');
const regime = require('../src/macro/regime');
const calendar = require('../src/collect/marketCalendar');
const { broker } = require('../src/broker');
const executor = require('../src/strategy/orderExecutor');
const runtime = require('../src/core/runtime');
const { heartbeatDetector } = require('../src/features/detectors/heartbeat');

const signal = { symbol: 'AAPL', signal: 'buy', price: 100, stopLoss: 95, takeProfit: 110, atr: 2, reason: 'test' };
const originals = { collectPrices: prices.collectPrices, lastPrint: prices.lastExtendedHoursPrint, collectBars: bars.collectBars,
  getFundamentals: fundamentals.getFundamentals, getRegime: regime.getRegime };
let requests, held, open, brokerOrder, session, print;

beforeEach(async () => {
  store.resetStorage();
  policy.loadPolicy();
  const p = policy.getPolicy();
  policy.useEphemeralPolicy({ ...p, risk: { ...p.risk, earningsBlackoutDays: 0, riskPerTradePct: null, targetVolatilityPct: null, minRewardRisk: null } });
  state.updateState({ positionSnapshots: {}, accountId: 'alpaca:paper:acct', paused: false, dailyLossHalted: false, startOfDayEquity: 100000 });
  requests = []; held = []; open = []; brokerOrder = null; session = 'extended';
  print = { price: 100.1, tradedAt: new Date().toISOString(), ageMs: 30_000 };
  broker.marketSession = async () => session;
  broker.getAccountInfo = async () => ({ accountId: 'acct', equity: 100000, cash: 100000, buyingPower: 100000, previousCloseEquity: 100000 });
  broker.getPositions = async () => held;
  broker.getOpenOrders = async () => open;
  broker.getOrder = async () => brokerOrder;
  broker.findOrder = async () => brokerOrder;
  broker.placeOrder = async req => { requests.push(req); return { id: 'broker-1' }; };
  broker.cancelOrder = async id => { open = open.filter(o => o.id !== id); if (brokerOrder?.id === id) brokerOrder = { ...brokerOrder, status: 'cancelled' }; };
  prices.lastExtendedHoursPrint = async () => print;
  prices.collectPrices = async () => { throw new Error('regular-hours quotes must not price an extended-hours order'); };
  bars.collectBars = async () => ({ stale: false, asOf: new Date().toISOString(), value: Array.from({ length: 200 }, (_, i) => ({ t: new Date(Date.now() - (200 - i) * 86400000).toISOString(), o: 20 + i * .4, h: 21 + i * .4, l: 19 + i * .4, c: 20.5 + i * .4, v: 100000 + i * 1000 })) });
  fundamentals.getFundamentals = async () => ({ calendar: { nextEarningsAt: null, daysUntil: null } });
  regime.getRegime = async () => ({ regime: 'expansion', confidence: 'high' });
  await runtime.initializeAccount();
});
after(() => {
  Object.assign(prices, { collectPrices: originals.collectPrices, lastExtendedHoursPrint: originals.lastPrint });
  bars.collectBars = originals.collectBars; fundamentals.getFundamentals = originals.getFundamentals; regime.getRegime = originals.getRegime;
  runtime.stopRuntime(); store.closeStorage();
});

test('an extended-hours entry is a day limit flagged for extended hours, priced from the last trade', async () => {
  const v = await orders.validateEntry(signal, 2);
  assert.equal(v.session, 'extended');
  assert.equal(v.price, 100.6); // 100.1 × 1.005, floored to the cent
  await orders.actEntry(v, 'cid');
  assert.deepEqual(
    { type: requests[0].type, tif: requests[0].timeInForce, ext: requests[0].extendedHours, limit: requests[0].limitPrice },
    { type: 'limit', tif: 'day', ext: true, limit: 100.6 });
});

test('a regular-session entry keeps its IOC limit and is not flagged', async () => {
  session = 'regular';
  prices.collectPrices = async () => new Map([['AAPL', { value: 100.13, stale: false, asOf: new Date().toISOString() }]]);
  const v = await orders.validateEntry(signal, 2);
  await orders.actEntry(v, 'cid');
  assert.equal(requests[0].timeInForce, 'ioc');
  assert.equal(requests[0].extendedHours, undefined);
});

test('an old or missing last trade refuses the order', async () => {
  print = { ...print, ageMs: 20 * 60_000 };
  await assert.rejects(() => orders.validateEntry(signal, 2), err => err.rule === 'quote_unavailable' && /20 min ago/.test(err.message));
  print = null;
  await assert.rejects(() => orders.validateEntry(signal, 2), err => err.rule === 'quote_unavailable');
});

test('closed, and an unreadable calendar, refuse both entries and exits', async () => {
  session = 'closed';
  await assert.rejects(() => orders.validateEntry(signal, 2), err => err.rule === 'market_closed');
  held = [{ symbol: 'AAPL', qty: 2, avgCost: 100, marketValue: 200 }];
  state.openPositionSnapshot({ symbol: 'AAPL', entryPrice: 100, stopLevel: 95 });
  await assert.rejects(() => orders.validateExit('AAPL'), err => err.rule === 'market_closed');
  broker.marketSession = async () => { throw new Error('calendar down'); };
  await assert.rejects(() => orders.validateExit('AAPL'), err => err.rule === 'market_closed' && /calendar down/.test(err.message));
});

test('an extended-hours exit cancels our stop, then sells with a limit under the last trade', async () => {
  held = [{ symbol: 'AAPL', qty: 2, avgCost: 100, marketValue: 200 }];
  state.openPositionSnapshot({ symbol: 'AAPL', entryPrice: 100, stopLevel: 95, stopOrderId: 'our-stop' });
  open = [{ id: 'our-stop', symbol: 'AAPL', side: 'sell', qty: 2, filled: 0, type: 'stop', rawType: 'stop', stopPrice: 95 }];
  const v = await orders.validateExit('AAPL');
  assert.equal(v.limitPrice, 99.6); // 100.1 × 0.995, rounded up to the cent
  print = { ...print, price: 99 };   // re-priced at submission, after the stop is cancelled
  const r = await orders.actExit('AAPL', 'test', v, 'cid');
  assert.equal(open.length, 0);
  assert.equal(r.extendedHours, true);
  assert.deepEqual({ type: requests[0].type, tif: requests[0].timeInForce, ext: requests[0].extendedHours, limit: requests[0].limitPrice },
    { type: 'limit', tif: 'day', ext: true, limit: 98.51 });
});

test('a sell that cannot be re-priced after the cancel fails cleanly instead of pausing on an unknown', async () => {
  held = [{ symbol: 'AAPL', qty: 2, avgCost: 100, marketValue: 200 }];
  state.openPositionSnapshot({ symbol: 'AAPL', entryPrice: 100, stopLevel: 95, stopOrderId: 'our-stop' });
  open = [{ id: 'our-stop', symbol: 'AAPL', side: 'sell', qty: 2, filled: 0, type: 'stop', rawType: 'stop', stopPrice: 95 }];
  const p = actions.createOrder({ kind: 'exit', symbol: 'AAPL', venue: 'paper', params: { qty: 2 }, reason: 'test', timeoutMs: 60000, automatic: true });
  const validate = orders.validateExit;
  // Validation sees a fresh trade; by submission the tape has gone quiet.
  orders.validateExit = async (...a) => { const v = await validate(...a); print = { ...print, ageMs: 10 * 60_000 }; return v; };
  try { await executor.sweepOrders(); } finally { orders.validateExit = validate; }
  assert.equal(requests.length, 0);
  assert.equal(actions.getOrder(p.id).status, 'failed');
  assert.match(actions.getOrder(p.id).result.error, /extended-hours orders need a trade within/);
  assert.equal(state.getState().paused, false);
});

test('a resting extended-hours order is cancelled after its time limit and the outcome recorded', async () => {
  const p = actions.createOrder({ kind: 'entry', symbol: 'AAPL', venue: 'paper', params: { signal, qty: 2, maxQty: 2 }, reason: 'test', timeoutMs: 60000, automatic: true });
  const validate = orders.validateEntry;
  orders.validateEntry = async (s, q) => ({ ...s, regimeQty: q, session: 'extended' });
  brokerOrder = { id: 'broker-1', symbol: 'AAPL', side: 'buy', qty: 2, filledQty: 0, filledPrice: null, status: 'open' };
  try { await executor.sweepOrders(); } finally { orders.validateEntry = validate; }
  const submitted = actions.getOrder(p.id);
  assert.equal(submitted.status, 'submitted');
  assert.equal(submitted.result.extendedHours, true);

  // Inside the limit: left resting.
  await executor.sweepOrders();
  assert.equal(actions.getOrder(p.id).status, 'submitted');

  // Past it: cancelled, and with nothing filled the action fails and frees the queue.
  const record = actions.getOrder(p.id);
  store.saveRecord('orders', p.id, { ...record, result: { ...record.result, submittedAt: Date.now() - orders.EXTENDED_ORDER_TTL_MS - 1 } });
  await executor.sweepOrders();
  assert.equal(brokerOrder.status, 'cancelled');
  assert.equal(actions.getOrder(p.id).status, 'failed');
  assert.equal(state.getState().paused, false);
});

test('a partly filled extended-hours entry keeps its fill when the rest is cancelled', async () => {
  const p = actions.createOrder({ kind: 'entry', symbol: 'AAPL', venue: 'paper', params: { signal, qty: 2, maxQty: 2 }, reason: 'test', timeoutMs: 60000, automatic: true });
  actions.transitionOrder(p.id, 'executing');
  actions.transitionOrder(p.id, 'submitted', { result: { brokerOrderId: 'broker-1', qty: 2, extendedHours: true, submittedAt: Date.now() - orders.EXTENDED_ORDER_TTL_MS - 1 } });
  brokerOrder = { id: 'broker-1', symbol: 'AAPL', side: 'buy', qty: 2, filledQty: 1, filledPrice: 100.4, status: 'partial' };
  await executor.sweepOrders();
  assert.equal(actions.getOrder(p.id).status, 'executed');
  assert.equal(actions.getOrder(p.id).result.filledQty, 1);
  assert.equal(state.getPositionSnapshot('AAPL').entryPrice, 100.4);
});

test('the calendar places extended hours, half days and holidays', async () => {
  const http = require('../src/core/alpacaHttp');
  const get = http.alpacaTrading.get;
  http.alpacaTrading.get = async () => ({ data: [
    { date: '2026-11-25', open: '09:30', close: '16:00', session_open: '0400', session_close: '2000' },
    { date: '2026-11-27', open: '09:30', close: '13:00', session_open: '0400', session_close: '1700' },
  ] });
  try {
    const at = iso => { calendar.resetCalendarCache(); return calendar.venueSession(new Date(iso)); };
    assert.equal(await at('2026-11-25T12:00:00Z'), 'extended');  // 07:00 ET
    assert.equal(await at('2026-11-25T15:00:00Z'), 'regular');   // 10:00 ET
    assert.equal(await at('2026-11-25T23:30:00Z'), 'extended');  // 18:30 ET
    assert.equal(await at('2026-11-26T02:00:00Z'), 'closed');    // 21:00 ET
    assert.equal(await at('2026-11-26T15:00:00Z'), 'closed');    // Thanksgiving: no row
    assert.equal(await at('2026-11-27T19:00:00Z'), 'extended');  // 14:00 ET on a half day
    assert.equal(await at('2026-11-27T22:30:00Z'), 'closed');    // 17:30 ET, past the half-day session
  } finally { http.alpacaTrading.get = get; calendar.resetCalendarCache(); }
});

test('the heartbeat paces the trader through extended hours and goes quiet overnight', () => {
  const p = policy.getPolicy();
  const beat = s => heartbeatDetector.evaluate({ session: s, account: { positionCount: 1, dayPnLPct: 0, equity: 100000 }, positions: { AAPL: {} } }, p)[0];
  assert.equal(beat('afterhours').severity, 'urgent');
  assert.equal(beat('afterhours').cooldownMs, p.triggers.heartbeatWithPositionsMs);
  assert.equal(beat('premarket').severity, 'urgent');
  assert.equal(beat('closed').severity, 'info');
});
