// The daily-loss baseline chosen by ensureDailyReset (src/features/scheduler.ts).
// `collectAccount` is stubbed at its module, so nothing here reaches a broker or the network.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-daily-reset-'));
Object.assign(process.env, {
  DATA_DIR: dir, BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
  ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
});
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access'); };
require('http').request = denyNetwork;
require('https').request = denyNetwork;
global.fetch = denyNetwork;

const state = require('../src/state/state');
const store = require('../src/core/storage');
const brokerSource = require('../src/collect/brokerSource');

// The scheduler imports collectAccount through `../collect`, which re-exports this module's
// binding at call time; replacing it here is enough to control what the reset reads.
let accountReply;
brokerSource.collectAccount = async () => accountReply;
const { ensureDailyReset } = require('../src/features/scheduler');

// 2026-03-02 is before the US DST change, so ET is UTC-5.
const AT_0800_ET = new Date('2026-03-02T13:00:00.000Z');
const AT_1000_ET = new Date('2026-03-02T15:00:00.000Z');
const YESTERDAY = '2026-03-01';
const TODAY = '2026-03-02';

function account(now, value) {
  return { value, source: 'alpaca', asOf: now.toISOString(), fetchedAt: now.toISOString(), stale: false };
}

function seed() {
  state.useEphemeralState({ startOfDayEquity: 111_111, lastResetDate: YESTERDAY });
}

beforeEach(() => {
  store.resetStorage();
  accountReply = undefined;
});

after(() => store.closeStorage());

test('after the open the daily-loss baseline is the previous close, not current equity', async () => {
  seed();
  accountReply = account(AT_1000_ET, {
    equity: 101_000, cash: 50_000, buyingPower: 101_000, previousCloseEquity: 98_000,
  });

  assert.equal(await ensureDailyReset(AT_1000_ET), true);
  assert.equal(state.getState().startOfDayEquity, 98_000,
    'a mid-session reset must measure against the previous close, not against equity after the drawdown');
});

test('before the open the daily-loss baseline is current equity, even when a previous close exists', async () => {
  seed();
  accountReply = account(AT_0800_ET, {
    equity: 100_000, cash: 50_000, buyingPower: 100_000, previousCloseEquity: 98_000,
  });

  assert.equal(await ensureDailyReset(AT_0800_ET), true);
  assert.equal(state.getState().startOfDayEquity, 100_000,
    'before 09:30 ET current equity is the start of the day');
});

test('after the open with no previous close the baseline falls back to current equity and the day advances', async () => {
  seed();
  accountReply = account(AT_1000_ET, { equity: 100_000, cash: 50_000, buyingPower: 100_000 });

  assert.equal(await ensureDailyReset(AT_1000_ET), true);
  assert.equal(state.getState().startOfDayEquity, 100_000,
    'without a previous close the only usable baseline is current equity');
  assert.equal(state.getState().lastResetDate, TODAY, 'a usable baseline must advance the reset date');
});

test('after the open with zero equity the reset is deferred and lastResetDate stays put', async () => {
  seed();
  accountReply = account(AT_1000_ET, { equity: 0, cash: 0, buyingPower: 0 });

  assert.equal(await ensureDailyReset(AT_1000_ET), false);
  assert.equal(state.getState().lastResetDate, YESTERDAY,
    'a zero baseline must not advance lastResetDate, otherwise nothing retries the reset');
  assert.equal(state.getState().startOfDayEquity, 111_111, 'the stale baseline is left untouched');
});
