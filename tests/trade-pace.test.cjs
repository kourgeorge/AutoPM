const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-pace-'));
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
const { recordFills } = require('../src/review/fills');
const pace = require('../src/strategy/tradePace');
const trail = require('../src/strategy/trailingStop');
const journal = require('../src/journal/journal');
const { broker } = require('../src/broker');
const runtime = require('../src/core/runtime');

const signal = { symbol: 'AAPL', signal: 'buy', price: 100, stopLoss: 95, takeProfit: 110, atr: 2, reason: 'test' };
let open, held, replaced;

function usePolicy(risk = {}, automation = {}) {
  policy.loadPolicy();
  const p = policy.getPolicy();
  policy.useEphemeralPolicy({ ...p, risk: { ...p.risk, ...risk }, automation: { ...p.automation, level: { ...p.automation.level, ...automation } } });
}

beforeEach(async () => {
  store.resetStorage();
  usePolicy();
  state.updateState({ positionSnapshots: {}, accountId: 'alpaca:paper:acct', paused: false, dailyLossHalted: false, startOfDayEquity: 100000 });
  open = []; held = []; replaced = [];
  broker.marketSession = async () => 'regular';
  broker.getAccountInfo = async () => ({ accountId: 'acct', equity: 100000, cash: 100000, buyingPower: 100000, previousCloseEquity: 100000 });
  broker.getPositions = async () => held;
  broker.getOpenOrders = async () => open;
  broker.replaceStopOrder = async (id, price) => {
    replaced.push({ id, price });
    const next = { ...open.find(o => o.id === id), id: id + '-r', stopPrice: price };
    open = [...open.filter(o => o.id !== id), next];
    return { id: next.id };
  };
  await runtime.initializeAccount();
});
after(() => { runtime.stopRuntime(); store.closeStorage(); });

// ── The daily entry cap ─────────────────────────────────────────────────────────

const order = (status, createdAt = Date.now(), extra = {}) => ({ kind: 'entry', status, createdAt, result: null, ...extra });

test('only entries that reached the broker today count toward the cap', () => {
  const now = new Date('2026-10-19T15:00:00Z');
  const today = now.getTime(), yesterday = today - 86_400_000;
  const list = [
    order('executed', today), order('submitted', today), order('unknown', today),
    order('rejected', today), order('expired', today), order('pending', today), order('approved', today),
    order('failed', today), order('failed', today, { result: { filledQty: 3 } }),
    order('executed', yesterday), { ...order('executed', today), kind: 'exit' },
  ];
  assert.equal(pace.entriesToday(list, now), 4);
  assert.equal(pace.entryCapVeto(null, list, now), null);
  assert.equal(pace.entryCapVeto(5, list, now), null);
  assert.match(pace.entryCapVeto(4, list, now), /4 new entries have already been sent today/);
});

test('the day is the ET trading day, not the UTC date', () => {
  // 23:30 ET on the 19th is already the 20th in UTC.
  const lateEvening = Date.parse('2026-10-20T03:30:00Z');
  assert.equal(pace.entriesToday([order('executed', lateEvening)], new Date('2026-10-19T14:00:00Z')), 1);
  assert.equal(pace.entriesToday([order('executed', lateEvening)], new Date('2026-10-20T14:00:00Z')), 0);
});

test('an entry past the daily cap is refused as max_entries_today', async () => {
  usePolicy({ maxEntriesPerDay: 1 });
  const p = actions.createOrder({ kind: 'entry', symbol: 'MSFT', venue: 'paper', params: { signal: { ...signal, symbol: 'MSFT' }, qty: 1 }, reason: 'earlier', timeoutMs: 60000, automatic: true });
  actions.transitionOrder(p.id, 'executing');
  await assert.rejects(() => orders.validateEntry(signal, 2), err => err.rule === 'max_entries_today');
});

test('an approved order re-validated by the executor does not count against itself', () => {
  const p = actions.createOrder({ kind: 'entry', symbol: 'AAPL', venue: 'paper', params: { signal, qty: 1 }, reason: 'mine', timeoutMs: 60000, automatic: true });
  assert.equal(actions.getOrder(p.id).status, 'approved');
  assert.equal(pace.entryCapVeto(1, actions.listOrders()), null);
});

// ── The cooldown after a loss ───────────────────────────────────────────────────

const outcome = (symbol, grossPnL, exitAt) => ({ symbol, grossPnL, returnPct: grossPnL, exitAt });

test('a recent losing round trip in the same symbol blocks it; a win, another symbol or an old loss does not', () => {
  const now = new Date('2026-10-19T15:00:00Z');
  const hourAgo = '2026-10-19T14:00:00Z', twoDaysAgo = '2026-10-17T15:00:00Z';
  assert.match(pace.lossCooldownVeto(24, 'AAPL', [outcome('AAPL', -50, hourAgo)], now), /until 2026-10-20T14:00:00/);
  assert.equal(pace.lossCooldownVeto(24, 'AAPL', [outcome('AAPL', 50, hourAgo)], now), null);
  assert.equal(pace.lossCooldownVeto(24, 'AAPL', [outcome('MSFT', -50, hourAgo)], now), null);
  assert.equal(pace.lossCooldownVeto(24, 'AAPL', [outcome('AAPL', -50, twoDaysAgo)], now), null);
  assert.equal(pace.lossCooldownVeto(null, 'AAPL', [outcome('AAPL', -50, hourAgo)], now), null);
});

test('an entry into a symbol that just closed at a loss is refused as loss_cooldown', async () => {
  usePolicy({ lossCooldownHours: 24 });
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  recordFills([
    { execId: 'pace-buy', brokerOrderId: 'b1', permId: null, symbol: 'AAPL', side: 'buy', qty: 2, price: 100, fee: null, at: at(120) },
    { execId: 'pace-sell', brokerOrderId: 's1', permId: null, symbol: 'AAPL', side: 'sell', qty: 2, price: 95, fee: null, at: at(60) },
  ]);
  await assert.rejects(() => orders.validateEntry(signal, 2), err => err.rule === 'loss_cooldown' && /AAPL closed at a loss/.test(err.message));
});

// ── The trailing stop ───────────────────────────────────────────────────────────

const position = (extra = {}) => ({ symbol: 'AAPL', qty: 10, price: 118, stale: false, sessionHigh: 120, atr: 2, ...extra });

test('the trail sits a fixed ATR distance below the high and only ever moves up', () => {
  assert.equal(trail.trailTarget(position(), 100, 2), 116);   // 120 - 2×2
  assert.equal(trail.trailTarget(position(), 116, 2), null);  // already there
  assert.equal(trail.trailTarget(position(), 117, 2), null);  // the trader is tighter: never lowered
  assert.equal(trail.trailTarget(position(), 115.9, 2), null); // a 10-cent raise is below the minimum step
  assert.equal(trail.trailTarget(position(), 100, null), null); // off
});

test('the trail does nothing on missing, stale or breaching inputs', () => {
  assert.equal(trail.trailTarget(position({ stale: true }), 100, 2), null);
  assert.equal(trail.trailTarget(position({ atr: null }), 100, 2), null);
  assert.equal(trail.trailTarget(position({ price: null }), 100, 2), null);
  assert.equal(trail.trailTarget(position(), null, 2), null);          // no stop armed yet
  assert.equal(trail.trailTarget(position({ price: 115 }), 100, 2), null); // trailed level is above the price: a breach, not a raise
});

test('the trail is off unless stop adjustments are automatic, and skips stale ticks', () => {
  state.openPositionSnapshot({ symbol: 'AAPL', entryPrice: 100, stopLevel: 100 });
  const data = { positions: { AAPL: position() } };
  usePolicy({ trailingStopAtrMult: 2 }, { stopAdjust: 'auto' });
  assert.equal(trail.trailPlans(data, policy.getPolicy()).length, 1);
  assert.equal(trail.trailPlans({ ...data, ordersStale: true }, policy.getPolicy()).length, 0);
  usePolicy({ trailingStopAtrMult: 2 }, { stopAdjust: 'manual' });
  assert.equal(trail.trailPlans(data, policy.getPolicy()).length, 0);
});

test('a tick raises the resting stop at the broker and journals it as the guard', async () => {
  usePolicy({ trailingStopAtrMult: 2 }, { stopAdjust: 'auto' });
  held = [{ symbol: 'AAPL', qty: 10, avgCost: 100, marketValue: 1180 }];
  open = [{ id: 'our-stop', symbol: 'AAPL', side: 'sell', qty: 10, filled: 0, type: 'stop', rawType: 'stop', stopPrice: 100 }];
  state.openPositionSnapshot({ symbol: 'AAPL', entryPrice: 100, stopLevel: 100, stopOrderId: 'our-stop' });
  await trail.trailStops({ positions: { AAPL: position() } }, policy.getPolicy());
  assert.deepEqual(replaced, [{ id: 'our-stop', price: 116 }]);
  assert.equal(state.getPositionSnapshot('AAPL').stopLevel, 116);
  assert.equal(state.getPositionSnapshot('AAPL').stopOrderId, 'our-stop-r');
  const [record] = journal.readDecisions({ symbol: 'AAPL' });
  assert.deepEqual({ kind: record.kind, actor: record.actor, stop: record.intendedStop, status: record.orderStatus },
    { kind: 'adjustment', actor: 'guard', stop: 116, status: 'executed' });
});

test('a refused raise leaves the record at the stop that actually rests', async () => {
  usePolicy({ trailingStopAtrMult: 2 }, { stopAdjust: 'auto' });
  held = [{ symbol: 'AAPL', qty: 10, avgCost: 100, marketValue: 1180 }];
  open = []; // the recorded stop is not at the broker, so the move is refused before any order
  state.openPositionSnapshot({ symbol: 'AAPL', entryPrice: 100, stopLevel: 100, stopOrderId: 'gone' });
  await trail.trailStops({ positions: { AAPL: position() } }, policy.getPolicy());
  assert.equal(replaced.length, 0);
  assert.equal(state.getPositionSnapshot('AAPL').stopLevel, 100);
  assert.equal(state.getState().paused, false);
});

test('a symbol with an order in flight is left alone', async () => {
  usePolicy({ trailingStopAtrMult: 2 }, { stopAdjust: 'auto' });
  held = [{ symbol: 'AAPL', qty: 10, avgCost: 100, marketValue: 1180 }];
  open = [{ id: 'our-stop', symbol: 'AAPL', side: 'sell', qty: 10, filled: 0, type: 'stop', rawType: 'stop', stopPrice: 100 }];
  state.openPositionSnapshot({ symbol: 'AAPL', entryPrice: 100, stopLevel: 100, stopOrderId: 'our-stop' });
  actions.createOrder({ kind: 'exit', symbol: 'AAPL', venue: 'paper', params: { qty: 10 }, reason: 'selling', timeoutMs: 60000 });
  await trail.trailStops({ positions: { AAPL: position() } }, policy.getPolicy());
  assert.equal(replaced.length, 0);
});
