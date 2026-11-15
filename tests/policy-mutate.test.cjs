// updateTradingSettings (src/policy/mutate.ts) is how the chat assistant changes risk settings
// and the watchlist. Every test runs against a fresh temporary DATA_DIR, never real data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-mutate-'));
Object.assign(process.env, { DATA_DIR: dir, BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test', ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets' });
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access'); };
require('http').request = denyNetwork;
require('https').request = denyNetwork;
global.fetch = denyNetwork;
const store = require('../src/core/storage');
const policy = require('../src/policy/load');
const { updateTradingSettings } = require('../src/policy/mutate');

const SETTINGS_FILE = path.join(dir, 'db', 'trade-settings.json');
const savedRisk = () => JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).settings.risk;
const savedFileText = () => fs.readFileSync(SETTINGS_FILE, 'utf8');

beforeEach(() => {
  store.resetStorage();      // removes data/db, including trade-settings.json
  policy.loadPolicy();       // writes the shipped default as the account's settings
});
after(() => { store.closeStorage(); fs.rmSync(dir, { recursive: true, force: true }); });

test('the temporary DATA_DIR is the one being written', () => {
  assert.ok(SETTINGS_FILE.startsWith(os.tmpdir()) || SETTINGS_FILE.startsWith(fs.realpathSync(os.tmpdir())));
  assert.ok(fs.existsSync(SETTINGS_FILE));
});

test('setting maxEntriesPerDay to 2 saves it and bumps the version by one', () => {
  const before = policy.getPolicy().version;
  const result = updateTradingSettings({ maxEntriesPerDay: 2 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.version, before + 1);
  assert.equal(savedRisk().maxEntriesPerDay, 2);
  assert.equal(policy.getPolicy().risk.maxEntriesPerDay, 2);
});

for (const field of ['maxEntriesPerDay', 'lossCooldownHours', 'trailingStopAtrMult']) {
  test(`${field}: null turns the setting off and is saved as null`, () => {
    const on = { maxEntriesPerDay: 3, lossCooldownHours: 24, trailingStopAtrMult: 2 }[field];
    assert.equal(updateTradingSettings({ [field]: on }).ok, true);
    assert.equal(savedRisk()[field], on);
    const result = updateTradingSettings({ [field]: null });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(field in savedRisk(), `${field} key should stay in the saved file`);
    assert.equal(savedRisk()[field], null);
    assert.equal(policy.getPolicy().risk[field], null);
  });
}

test('an empty change applies nothing and keeps the version', () => {
  const before = policy.getPolicy().version;
  const fileBefore = savedFileText();
  const result = updateTradingSettings({});
  assert.deepEqual(result, { ok: true, applied: [], version: before });
  assert.equal(savedFileText(), fileBefore);
});

test('adding a symbol already on the watchlist applies nothing', () => {
  const before = policy.getPolicy().version;
  const existing = policy.getPolicy().strategy.watchlist[0];
  const result = updateTradingSettings({ addToWatchlist: [existing], removeFromWatchlist: ['NOT_ON_LIST'] });
  assert.deepEqual(result, { ok: true, applied: [], version: before });
});

test('watchlist add and remove are both saved', () => {
  const [first] = policy.getPolicy().strategy.watchlist;
  const result = updateTradingSettings({ addToWatchlist: ['ZZZZ'], removeFromWatchlist: [first] });
  assert.equal(result.ok, true, JSON.stringify(result));
  const list = JSON.parse(savedFileText()).settings.strategy.watchlist;
  assert.ok(list.includes('ZZZZ'));
  assert.ok(!list.includes(first));
});

test('a saved policy with no risk section returns ok:false instead of throwing', () => {
  const file = JSON.parse(savedFileText());
  delete file.settings.risk;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(file));
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(SETTINGS_FILE, later, later);   // a distinct mtime so the read cache is not reused
  let result;
  assert.doesNotThrow(() => { result = updateTradingSettings({ maxEntriesPerDay: 2 }); });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /no risk section/);
});

const outOfRange = [
  ['positionSizePct 5 (a percent, but the field is a fraction)', { positionSizePct: 5 }],
  ['positionSizePct below zero', { positionSizePct: -0.1 }],
  ['negative maxPositions', { maxPositions: -1 }],
  ['maxPositions of zero', { maxPositions: 0 }],
  ['maxPositions that is not a whole number', { maxPositions: 2.5 }],
  ['maxDailyLossPct 3 (a percent, but the field is a fraction)', { maxDailyLossPct: 3 }],
  ['maxGrossExposurePct 80 (a percent, but the field is a fraction)', { maxGrossExposurePct: 80 }],
  ['maxEntriesPerDay of zero', { maxEntriesPerDay: 0 }],
  ['maxEntriesPerDay above 50', { maxEntriesPerDay: 51 }],
  ['negative lossCooldownHours', { lossCooldownHours: -1 }],
  ['trailingStopAtrMult below 0.5', { trailingStopAtrMult: 0.1 }],
  ['maxPositions given as text', { maxPositions: '5' }],
];
for (const [name, change] of outOfRange) {
  test(`rejects ${name} and leaves the saved settings unchanged`, () => {
    const fileBefore = savedFileText();
    const result = updateTradingSettings(change);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.ok(result.errors.length > 0);
    assert.equal(savedFileText(), fileBefore);
  });
}
