const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-hbq-'));
Object.assign(process.env, { DATA_DIR: dir, BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test', ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets' });
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access'); };
require('http').request = denyNetwork;
require('https').request = denyNetwork;
global.fetch = denyNetwork;
const state = require('../src/state/state');
const store = require('../src/core/storage');
const policy = require('../src/policy/load');
const bus = require('../src/features/eventBus');
const hb = require('../src/features/detectors/heartbeat');

// 2026-03-02 is a Monday; 15:00Z = 10:00 ET, regular hours.
const BASE = Date.parse('2026-03-02T15:00:00Z');
const MIN = 60_000;

beforeEach(() => {
  store.resetStorage();
  policy.loadPolicy();
  state.updateState({ positionSnapshots: {}, eventCooldowns: {}, armedTriggers: [], paused: false, startOfDayEquity: 100000 });
  bus.resetEventRegistry();
  hb.resetHeartbeatGate();
});

function tick(minutes, over = {}) {
  const { price = 100, atr = 2, session = 'open', orders = [], tickAt } = over;
  return {
    positions: { AAPL: { symbol: 'AAPL', qty: 10, price, atr, stale: false, staleReason: null, entryPrice: 100, sessionHigh: 101, sessionLow: 99,
      stopLevel: 90, takeProfitLevel: 120, pnlPct: 0, drawdownFromHighPct: 0, distanceToStopPct: 10, distanceToTargetPct: 20,
      mfePct: 0, maePct: 0, emaFast: null, emaSlow: null, rsi: null, heldForMs: null } },
    watchlist: {}, orders,
    account: { equity: 100000, buyingPower: 50000, cash: 50000, invested: 50000, stale: false, staleReason: null, startOfDayEquity: 100000, dayPnLPct: 0, positionCount: 1 },
    // At the default target nothing is asked of the scan; this keeps the test about the book.
    portfolio: { grossDeployedPct: 100, maxWeightPct: 1, maxWeightSymbol: 'AAPL', hhi: 0, maxSectorWeightPct: 0, maxSectorName: null, equityPeak: 100000, drawdownFromPeakPct: 0 },
    session, tickAt: tickAt ?? new Date(BASE + minutes * MIN).toISOString(), policyVersion: 1,
  };
}

function beat(minutes, over) {
  const data = tick(minutes, over);
  const fired = bus.publishTick([hb.heartbeatDetector], data, policy.getPolicy(), Date.parse(data.tickAt));
  return fired.find(e => e.kind === 'heartbeat');
}

test('a second heartbeat with an identical snapshot does not wake the trader and is logged', () => {
  const first = beat(0);
  assert.equal(first.severity, 'urgent');
  const second = beat(16);
  assert.ok(second, 'the beat still fires, as context');
  assert.equal(second.severity, 'info', 'info wakes nobody (wakesTrader is urgent/critical only)');
  assert.equal(bus.wakesTrader(second), false);
  assert.match(second.headline, /nothing changed since 10:00 ET, trader not woken/);
  assert.equal(second.evidence.quietSince, first.firedAt);
  assert.ok(bus.getPendingEvents().some(e => e.id === second.id), 'visible in the pending events (Live page)');
});

test('a small price move stays quiet; a move past 0.5 ATR wakes', () => {
  beat(0);
  assert.equal(beat(16, { price: 100.5 }).severity, 'info', '0.25 ATR');
  assert.equal(beat(32, { price: 101.5 }).severity, 'urgent', '0.75 ATR');
});

test('a new event since the last waking beat wakes it', () => {
  beat(0);
  bus.publishDiscrete('request_finished', { symbol: 'MSFT', cooldownKey: 'request_finished:r1', severity: 'warn', headline: 'research done', evidence: {} }, policy.getPolicy());
  assert.equal(beat(16).severity, 'urgent');
  // Seen once is enough: the same pending event does not wake the next beat again.
  assert.equal(beat(32).severity, 'info');
});

test('a session change wakes it', () => {
  // 15:50 ET then 16:06 ET: open -> afterhours on the same day.
  beat(0, { tickAt: '2026-03-02T20:50:00Z' });
  assert.equal(beat(0, { tickAt: '2026-03-02T21:06:00Z', session: 'afterhours' }).severity, 'urgent');
});

test('a new trading day wakes it', () => {
  beat(0, { tickAt: '2026-03-02T15:00:00Z' });
  assert.equal(beat(0, { tickAt: '2026-03-03T15:00:00Z' }).severity, 'urgent');
});

test('a managed holding whose stop goes missing wakes it', () => {
  state.upsertPositionSnapshot('AAPL', { entryPrice: 100, sessionHigh: 101, sessionLow: 99, stopLevel: 90, stopOrderId: 'stop-1' });
  const stop = { id: 'stop-1', symbol: 'AAPL', side: 'sell', qty: 10, filled: 0, type: 'stop', rawType: 'stop', stopPrice: 90 };
  beat(0, { orders: [stop] });
  assert.equal(beat(16, { orders: [stop] }).severity, 'info', 'still protected, nothing new');
  assert.equal(beat(32, { orders: [] }).severity, 'urgent', 'stop gone');
});

test('the maximum quiet time always lets a beat through', () => {
  beat(0);
  let m = 16;
  for (; m < hb.MAX_QUIET_MS_OPEN / MIN; m += 16) assert.equal(beat(m).severity, 'info', `quiet at +${m}m`);
  assert.equal(beat(m).severity, 'urgent', `woken at +${m}m`);
});

test('the fingerprint compare names what changed', () => {
  const outside = { eventIds: [], researchIds: [], requestIds: [], protection: {} };
  const p = policy.getPolicy();
  const a = hb.heartbeatFingerprint(tick(0), p, outside);
  assert.equal(hb.heartbeatChange(a, hb.heartbeatFingerprint(tick(16), p, outside)), null);
  assert.match(hb.heartbeatChange(a, hb.heartbeatFingerprint(tick(16, { price: 98.5 }), p, outside)), /moved/);
  // 91.5 is within 1 ATR (2) of the 90 stop.
  const nearStop = hb.heartbeatFingerprint(tick(16, { price: 91.5 }), p, outside);
  assert.equal(nearStop.positions.AAPL.nearStop, true);
  assert.match(hb.heartbeatChange(a, hb.heartbeatFingerprint(tick(16), p, { ...outside, requestIds: ['op-1'] })), /operator request/);
});
