// Both strategy modules that send orders (orderManager, stopOrders) share one guardedBroker
// from core/runtime. These checks prove a broker write is refused through each of them while
// the account is not initialized, and allowed through each once it is.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-test-'));
Object.assign(process.env, { DATA_DIR: dir, BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test', ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets' });
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access'); };
require('http').request = denyNetwork;
require('https').request = denyNetwork;
global.fetch = denyNetwork;
const state = require('../src/state/state');
const store = require('../src/core/storage');
const policy = require('../src/policy/load');
const runtime = require('../src/core/runtime');
const { broker } = require('../src/broker');
const orders = require('../src/strategy/orderManager');
const stops = require('../src/strategy/stopOrders');

let placed;
beforeEach(() => {
  runtime.stopRuntime();
  store.resetStorage();
  state.updateState({ positionSnapshots: {}, accountId: 'alpaca:paper:acct', paused: false });
  policy.loadPolicy();
  placed = [];
  broker.getAccountInfo = async () => ({ accountId: 'acct', equity: 100000, cash: 100000, buyingPower: 100000, previousCloseEquity: 100000 });
  broker.getPositions = async () => [{ symbol: 'AAPL', qty: 2, avgEntryPrice: 100, currentPrice: 100, marketValue: 200, unrealizedPL: 0 }];
  broker.getOpenOrders = async () => [];
  broker.placeOrder = async (req) => { placed.push(req); return { id: `b-${placed.length}`, status: 'accepted' }; };
  state.openPositionSnapshot({ symbol: 'AAPL', entryPrice: 100, stopLevel: 90 });
});
after(() => { runtime.stopRuntime(); store.closeStorage(); });

const entry = { symbol: 'AAPL', regimeQty: 1, price: 100, session: 'regular' };

test('the shared guardedBroker refuses a write while the account is not initialized', async () => {
  assert.throws(() => runtime.guardedBroker(), /Account is not initialized/);
});

test('orderManager: an entry is refused before init and sent after it', async () => {
  await assert.rejects(orders.actEntry(entry, 'c-1'), /Account is not initialized/);
  assert.equal(placed.length, 0);
  await runtime.initializeAccount();
  const sent = await orders.actEntry(entry, 'c-2');
  assert.equal(sent.status, 'submitted');
  assert.equal(placed.length, 1);
});

test('stopOrders: a stop is refused before init and sent after it', async () => {
  const refused = await stops.armStop('AAPL', 2, 90);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /Account is not initialized/);
  assert.equal(placed.length, 0);
  await runtime.initializeAccount();
  const armed = await stops.armStop('AAPL', 2, 90);
  assert.equal(armed.ok, true, armed.reason);
  assert.equal(placed.length, 1);
});
