const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
require('ts-node/register');
const { etDateOf } = require(path.join(root, 'src/core/time'));

// The deleted src/collect/etDate.ts, copied here as the reference behaviour.
const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
function oldEtDate(ms) {
  if (!Number.isFinite(ms)) return null;
  const parts = ET_PARTS.formatToParts(new Date(ms));
  const get = (type) => parts.find(p => p.type === type)?.value;
  const [y, m, d] = [get('year'), get('month'), get('day')];
  return y && m && d ? `${y}-${m}-${d}` : null;
}

test('etDateOf matches the old collect/etDate on DST edges, late evening and bad input', () => {
  const instants = [
    Date.parse('2026-03-08T06:59:00Z'), Date.parse('2026-03-08T07:01:00Z'),
    Date.parse('2026-11-01T05:00:00Z'), Date.parse('2026-11-01T05:30:00Z'),
    Date.parse('2026-11-01T05:59:00Z'), Date.parse('2026-11-01T06:00:00Z'),
    Date.parse('2026-07-15T03:30:00Z'), // 23:30 ET on 2026-07-14
    Date.parse('2026-01-15T04:30:00Z'), // 23:30 ET on 2026-01-14
    NaN, Infinity, Date.parse('not a date'),
  ];
  for (const ms of instants) assert.equal(etDateOf(ms), oldEtDate(ms), `at ${ms}`);
  assert.equal(etDateOf(Date.parse('2026-07-15T03:30:00Z')), '2026-07-14');
  assert.equal(etDateOf(NaN), null);
});
