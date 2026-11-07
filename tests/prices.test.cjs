// The price-safety rules in collect/priceSource.ts, fed the real snapshots they were written for.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, afterEach } = require('node:test');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-prices-'));
Object.assign(process.env, { DATA_DIR: dir, BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test', ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets' });
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access'); };
require('http').request = denyNetwork;
require('https').request = denyNetwork;
global.fetch = denyNetwork;
const { alpacaData } = require('../src/core/alpacaHttp');
const prices = require('../src/collect/priceSource');
const yahoo = require('../src/collect/yahoo');

const realNow = Date.now;
let snapshots;
const originalGet = alpacaData.get, originalQuote = yahoo.getQuoteRaw;
/** Fixes the clock at `iso` (also what `new Date()` reads). */
function at(iso) { const t = Date.parse(iso); Date.now = () => t; global.Date = class extends realDate { constructor(...a) { super(...(a.length ? a : [t])); } static now() { return t; } }; }
const realDate = Date;
beforeEach(() => { alpacaData.get = async () => ({ data: snapshots }); });
afterEach(() => { alpacaData.get = originalGet; yahoo.getQuoteRaw = originalQuote; global.Date = realDate; Date.now = realNow; });

test('a one-sided book (ask 0) is not halved into a price; the last trade stands', async () => {
  // Measured 2026-08-13 20:00Z: TSLA bid 324.20 ask 0, trade a few seconds earlier.
  at('2026-08-13T20:00:10Z');
  snapshots = { TSLA: {
    latestTrade: { p: 324.25, t: '2026-08-13T19:59:59.998Z' },
    latestQuote: { bp: 324.20, ap: 0, t: '2026-08-13T20:00:04.976Z' },
    dailyBar: { h: 330, l: 320 },
  } };
  const p = (await prices.collectPrices(['TSLA'])).get('TSLA');
  assert.equal(p.value, 324.25);
  assert.equal(p.tradeConfirmed, true);
});

test('a wide book\'s newer midpoint loses to the real trade before it', async () => {
  // Measured 2026-08-26: CRM last print 205.75 at 19:59:55, then bid 208.90 / ask 213.94.
  at('2026-08-26T19:30:00Z');
  snapshots = { CRM: {
    latestTrade: { p: 205.75, t: '2026-08-26T19:20:00Z' },
    latestQuote: { bp: 208.90, ap: 213.94, t: '2026-08-26T19:29:50Z' },
    dailyBar: { h: 206.31, l: 203.0 },
  } };
  const p = (await prices.collectPrices(['CRM'])).get('CRM');
  assert.equal(p.value, 205.75);
  assert.equal(p.tradeConfirmed, true);
});

test('with no trade at all, a wide midpoint is shown but cannot set a record', async () => {
  at('2026-08-26T19:30:00Z');
  snapshots = { CRM: {
    latestQuote: { bp: 208.90, ap: 213.94, t: '2026-08-26T19:29:50Z' },
    dailyBar: { h: 206.31, l: 203.0 },
  } };
  const p = (await prices.collectPrices(['CRM'])).get('CRM');
  assert.ok(Math.abs(p.value - 211.42) < 1e-9);
  assert.equal(p.tradeConfirmed, false);
});

test('a tight midpoint inside the day\'s range is confirmed', async () => {
  at('2026-08-26T15:00:00Z');
  snapshots = { CRM: {
    latestTrade: { p: 205.0, t: '2026-08-26T14:50:00Z' },
    latestQuote: { bp: 205.10, ap: 205.14, t: '2026-08-26T14:59:58Z' },
    dailyBar: { h: 206.31, l: 203.0 },
  } };
  const p = (await prices.collectPrices(['CRM'])).get('CRM');
  assert.equal(p.value, 205.12);
  assert.equal(p.tradeConfirmed, true);
});

test('an after-hours trade from hours ago is stale, not stamped fresh', async () => {
  // 2026-11-04 is a Wednesday; 23:00Z is 18:00 ET (after-hours). Last trade at the 16:00 close.
  at('2026-11-04T23:00:00Z');
  snapshots = { AAPL: { latestTrade: { p: 270, t: '2026-11-04T21:00:00Z' }, dailyBar: { h: 272, l: 268 } } };
  const p = (await prices.collectPrices(['AAPL'], 180_000)).get('AAPL');
  assert.equal(p.stale, true);
});

test('a Yahoo price with no timestamp is stale while anything trades', async () => {
  at('2026-11-04T16:00:00Z');
  snapshots = {};
  yahoo.getQuoteRaw = async () => ({ price: 100, asOf: undefined });
  const p = (await prices.collectPrices(['XYZ'], 180_000)).get('XYZ');
  assert.equal(p.value, 100);
  assert.equal(p.stale, true);
});
