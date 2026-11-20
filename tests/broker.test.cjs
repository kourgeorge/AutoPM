// The Alpaca adapter's translation of venue replies, with the HTTP client faked.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, afterEach } = require('node:test');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-broker-'));
Object.assign(process.env, { DATA_DIR: dir, BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test', ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets' });
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access'); };
require('http').request = denyNetwork;
require('https').request = denyNetwork;
global.fetch = denyNetwork;
const { alpacaTrading } = require('../src/core/alpacaHttp');
const { AlpacaBroker } = require('../src/broker/AlpacaBroker');
const { BrokerRejection } = require('../src/broker/errors');
const { isDefiniteRefusal } = require('../src/strategy/protectionIntent');

const original = { get: alpacaTrading.get, post: alpacaTrading.post, patch: alpacaTrading.patch, delete: alpacaTrading.delete };
let replies, sent;
beforeEach(() => {
  replies = {}; sent = [];
  for (const verb of ['get', 'post', 'patch', 'delete']) {
    alpacaTrading[verb] = async (url, body) => {
      sent.push({ verb, url, body });
      let reply = replies[verb + ' ' + url];
      if (typeof reply === 'function') reply = reply(body);
      if (reply instanceof Error) throw reply;
      if (reply === undefined) throw new Error('No fake reply for ' + verb + ' ' + url);
      return { data: reply };
    };
  }
});
afterEach(() => Object.assign(alpacaTrading, original));
const httpError = (status, message) => Object.assign(new Error('Request failed with status code ' + status), { response: { status, data: { message, code: 40010001 } } });

test('a missing previous-close equity is null, never NaN', async () => {
  replies['get /v2/account'] = { id: 'acct', equity: '1000', cash: '500', buying_power: '900', last_equity: '' };
  const info = await new AlpacaBroker().getAccountInfo();
  assert.equal(info.previousCloseEquity, null);
  assert.equal(info.equity, 1000);
});

test('OCO legs are flattened with their group, and order types are mapped', async () => {
  replies['get /v2/orders'] = [{ id: 'tp', symbol: 'AAPL', side: 'sell', qty: '2', filled_qty: '0', type: 'limit', limit_price: '110', order_class: 'oco', status: 'new',
    legs: [{ id: 'sl', symbol: 'AAPL', side: 'sell', qty: '2', filled_qty: '0', type: 'stop', stop_price: '95', status: 'held' }] }];
  const orders = await new AlpacaBroker().getOpenOrders();
  assert.deepEqual(orders.map(o => [o.id, o.type, o.groupId, o.stopPrice ?? o.limitPrice]), [['tp', 'limit', 'tp', 110], ['sl', 'stop', 'tp', 95]]);
});

test('an OCO reply yields the stop and take-profit ids from parent and legs', async () => {
  replies['post /v2/orders'] = { id: 'tp-1', limit_price: '110', legs: [{ id: 'sl-1', stop_price: '95' }] };
  const placed = await new AlpacaBroker().placeOco({ symbol: 'AAPL', qty: 2, stopPrice: 95, takeProfitPrice: 110 });
  assert.deepEqual(placed, { stopOrderId: 'sl-1', takeProfitOrderId: 'tp-1' });
  assert.equal(sent[0].body.order_class, 'oco');
  assert.equal(sent[0].body.time_in_force, 'gtc');
});

test('a venue refusal carries Alpaca\'s own words and counts as definite', async () => {
  replies['post /v2/orders'] = httpError(403, 'insufficient qty available for order');
  const err = await new AlpacaBroker().placeOrder({ symbol: 'AAPL', qty: 2, side: 'sell', type: 'stop', stopPrice: 95 }).catch(e => e);
  assert.ok(err instanceof BrokerRejection);
  assert.equal(err.status, 403);
  assert.match(err.message, /insufficient qty/);
  assert.equal(isDefiniteRefusal(err), true);
});

test('a dropped connection is not a definite refusal', async () => {
  replies['post /v2/orders'] = new Error('socket hang up');
  const err = await new AlpacaBroker().placeOrder({ symbol: 'AAPL', qty: 2, side: 'sell', type: 'stop', stopPrice: 95 }).catch(e => e);
  assert.ok(err instanceof BrokerRejection);
  assert.equal(err.status, null);
  assert.equal(isDefiniteRefusal(err), false);
});

test('stops are always good-till-cancelled; stock entries are day orders', async () => {
  replies['post /v2/orders'] = { id: 'x' };
  const b = new AlpacaBroker();
  await b.placeOrder({ symbol: 'AAPL', qty: 1, side: 'sell', type: 'stop', stopPrice: 95 });
  await b.placeOrder({ symbol: 'AAPL', qty: 1, side: 'buy', type: 'limit', limitPrice: 100 });
  assert.deepEqual(sent.map(s => s.body.time_in_force), ['gtc', 'day']);
});

test('order status mapping: replaced and expired read as cancelled, a 404 as missing', async () => {
  const b = new AlpacaBroker();
  replies['get /v2/orders/a'] = { id: 'a', status: 'replaced', qty: '1', filled_qty: '0' };
  assert.equal((await b.getOrder('a')).status, 'cancelled');
  replies['get /v2/orders/b'] = { id: 'b', status: 'new', qty: '2', filled_qty: '1' };
  assert.equal((await b.getOrder('b')).status, 'partial');
  replies['get /v2/orders/c'] = httpError(404, 'order not found');
  assert.equal(await b.getOrder('c'), null);
});

const fillRow = (id, over = {}) => ({ id, order_id: 'o-' + id, symbol: 'AAPL', side: 'buy', qty: '2', price: '100.5', transaction_time: '2026-11-19T15:00:00Z', ...over });

test('a fill with no price is not returned, so a later poll can still record it', async () => {
  replies['get /v2/account/activities'] = [fillRow('a1'), fillRow('a2', { side: 'sell', price: undefined })];
  const fills = await new AlpacaBroker().getFills();
  assert.deepEqual(fills.map(f => f.execId), ['a1']);
});

test('a normal fill keeps its price, qty, side and id', async () => {
  replies['get /v2/account/activities'] = [fillRow('a1', { side: 'sell', qty: '3', price: '42.25' })];
  const [f] = await new AlpacaBroker().getFills();
  assert.equal(f.execId, 'a1');
  assert.equal(f.side, 'sell');
  assert.equal(f.qty, 3);
  assert.equal(f.price, 42.25);
});

test('fills page through with page_token set to the last id of the previous page', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => fillRow('p' + i));
  const page2 = [fillRow('last')];
  replies['get /v2/account/activities'] = (opts) => (opts.params.page_token ? page2 : page1);
  const fills = await new AlpacaBroker().getFills();
  assert.equal(fills.length, 101);
  const calls = sent.filter(s => s.url === '/v2/account/activities');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.params.page_token, undefined);
  assert.equal(calls[1].body.params.page_token, 'p99');
});
