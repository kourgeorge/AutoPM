// Pins the link from a Yahoo `calendarEvents` payload to the `daysUntil` number that the
// earnings blackout veto (`earningsVeto`) reads. Pure functions only: no network, fixed clock.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
Object.assign(process.env, { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-fundamentals-')),
  BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
  ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets' });
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access in fundamentals test'); };
require('node:http').request = require('node:https').request = global.fetch = denyNetwork;

const { mapFundamentals } = require('../src/collect/fundamentals');
const { earningsVeto } = require('../src/strategy/orderManager');

const NOW = Date.parse('2026-11-19T15:00:00Z');
const withDates = (earningsDate, extra = {}) =>
  ({ calendarEvents: { earnings: { earningsDate, isEarningsDateEstimate: false, ...extra } } });

test('a print tomorrow at 00:00Z maps to daysUntil 0 and trips the blackout veto', () => {
  const f = mapFundamentals('AAPL', withDates([new Date('2026-11-20T00:00:00Z')]), ['calendarEvents'], NOW);
  assert.equal(f.calendar.nextEarningsAt, '2026-11-20T00:00:00.000Z');
  assert.equal(f.calendar.daysUntil, 0);
  assert.equal(f.calendar.earningsWindow, null);
  assert.equal(f.calendar.isEstimate, false);
  assert.equal(earningsVeto('AAPL', f, 5)?.rule, 'earnings_window');
});

test('daysUntil counts whole days, so a print 4.4 days out is still inside a 5-day blackout', () => {
  const f = mapFundamentals('AAPL', withDates([new Date('2026-11-24T00:00:00Z')]), ['calendarEvents'], NOW);
  assert.equal(f.calendar.daysUntil, 4);
  assert.equal(earningsVeto('AAPL', f, 5)?.rule, 'earnings_window');
});

test('a print exactly blackoutDays away is outside the blackout', () => {
  const f = mapFundamentals('AAPL', withDates([new Date('2026-11-24T15:00:00Z')]), ['calendarEvents'], NOW);
  assert.equal(f.calendar.daysUntil, 5);
  assert.equal(earningsVeto('AAPL', f, 5), null);
});

test('a date that has already passed is not kept as the next print', () => {
  const f = mapFundamentals('AAPL', withDates([new Date('2026-11-19T14:00:00Z')]), ['calendarEvents'], NOW);
  assert.equal(f.calendar.nextEarningsAt, null);
  assert.equal(f.calendar.daysUntil, null);
  assert.ok(f.caveats.some(c => c.includes('is in the past')), 'past-date caveat missing');
});

test('with two candidate dates the nearer future one is chosen, whatever the payload order', () => {
  const later = new Date('2026-12-04T00:00:00Z'), nearer = new Date('2026-11-21T00:00:00Z');
  const f = mapFundamentals('AAPL', withDates([later, nearer]), ['calendarEvents'], NOW);
  assert.equal(f.calendar.nextEarningsAt, '2026-11-21T00:00:00.000Z');
  assert.equal(f.calendar.daysUntil, 1);
  assert.deepEqual(f.calendar.earningsWindow, ['2026-11-21T00:00:00.000Z', '2026-12-04T00:00:00.000Z']);
  assert.equal(earningsVeto('AAPL', f, 5)?.rule, 'earnings_window');
});

test('a passed date next to a future one: the future one is chosen and no window is reported', () => {
  const f = mapFundamentals('AAPL', withDates([new Date('2026-11-01T00:00:00Z'), new Date('2026-11-21T00:00:00Z')]),
    ['calendarEvents'], NOW);
  assert.equal(f.calendar.nextEarningsAt, '2026-11-21T00:00:00.000Z');
  assert.equal(f.calendar.earningsWindow, null);
});

test('dates read back from the cache as ISO strings map the same as Date objects', () => {
  const f = mapFundamentals('AAPL', withDates(['2026-11-20T00:00:00.000Z']), ['calendarEvents'], NOW);
  assert.equal(f.calendar.nextEarningsAt, '2026-11-20T00:00:00.000Z');
  assert.equal(f.calendar.daysUntil, 0);
});

test('a single date (not wrapped in an array) is not misread as a print', () => {
  const f = mapFundamentals('AAPL', withDates(new Date('2026-11-20T00:00:00Z')), ['calendarEvents'], NOW);
  assert.equal(f.calendar.nextEarningsAt, null);
});

test('unparseable dates are dropped, not turned into a print', () => {
  const f = mapFundamentals('AAPL', withDates(['not a date', null, new Date('nope')]), ['calendarEvents'], NOW);
  assert.equal(f.calendar.nextEarningsAt, null);
  assert.equal(f.calendar.daysUntil, null);
});

test('no calendar data at all: no crash, and the veto answers "no print"', () => {
  for (const raw of [{}, null, undefined, { calendarEvents: {} }, { calendarEvents: { earnings: {} } }]) {
    const f = mapFundamentals('XLE', raw, [], NOW);
    assert.equal(f.calendar.nextEarningsAt, null);
    assert.equal(f.calendar.daysUntil, null);
    assert.equal(f.calendar.earningsWindow, null);
    assert.equal(f.calendar.isEstimate, null);
    assert.equal(earningsVeto('XLE', f, 5), null);
  }
});

test('an estimated date is flagged as an estimate', () => {
  const f = mapFundamentals('AAPL', withDates([new Date('2026-11-20T00:00:00Z')], { isEarningsDateEstimate: true }),
    ['calendarEvents'], NOW);
  assert.equal(f.calendar.isEstimate, true);
  assert.match(earningsVeto('AAPL', f, 5).message, /an estimated 2026-11-20/);
});
