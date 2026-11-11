const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { spawnSync } = require('node:child_process');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-storage-'));
process.env.DATA_DIR = directory;
require('ts-node/register');
const store = require('../src/core/storage');
after(() => { store.closeStorage(); fs.rmSync(directory, { recursive: true, force: true }); });

test('disk payloads preserve updates, deletes, ordering, filters and transaction rollback', () => {
  store.resetStorage();
  const first = store.appendRecord('records', 'a', 'first', { text: 'שלום 🌍', n: 1 });
  const second = store.appendRecord('records', 'b', 'second', { n: 2 });
  store.transaction(() => {
    store.saveRecord('records', 'a', { n: 3 });
    assert.equal(store.readRecord('records', 'a').n, 3);
    store.saveRecord('records', 'a', { n: 4 });
  });
  assert.equal(store.readRecord('records', 'a').n, 4);
  assert.throws(() => store.transaction(() => {
    store.deleteRecord('records', 'a');
    store.saveRecord('records', 'b', { n: 99 });
    store.appendRecord('records', 'c', 'third', { n: 5 });
    throw new Error('rollback');
  }), /rollback/);
  assert.deepEqual(store.readRecords('records'), [{ n: 4 }, { n: 2 }]);
  assert.equal(store.readRecord('records', 'c'), undefined);
  const before = fs.readFileSync(path.join(directory, 'db/records.jsonl'), 'utf8');
  store.closeStorage();
  assert.deepEqual(store.readRecords('records', 1), [{ n: 2 }]);
  assert.deepEqual(store.readRecords('records', undefined, first), [{ n: 2 }]);
  assert.deepEqual(store.readRecordPage('records', first, 1), [{ n: 2, seq: second }]);
  assert.deepEqual(store.listRecords('records', { desc: true, where: v => v.n > 2, limit: 1 }),
    [{ seq: first, id: 'a', at: 'first', value: { n: 4 } }]);
  assert.equal(fs.readFileSync(path.join(directory, 'db/records.jsonl'), 'utf8'), before);
  store.deleteRecord('records', 'b');
  store.closeStorage();
  assert.equal(store.readRecord('records', 'b'), undefined);
  assert.ok(store.appendRecord('other', 'next', 'now', {}) > second);
});

test('byte offsets handle blank lines, multibyte text and chunk boundaries', () => {
  store.resetStorage();
  fs.mkdirSync(path.join(directory, 'db'), { recursive: true });
  const file = path.join(directory, 'db/large.jsonl');
  const row = (seq, value) => JSON.stringify({ seq, id: String(seq), at: 'now', value });
  const large = { text: 'é'.repeat(9 * 1024 * 1024) };
  fs.writeFileSync(file, '\n' + row(1, large) + '\n \n' + row(2, { text: 'שלום 🌍' }));
  assert.deepEqual(store.readRecord('large', '1'), large);
  assert.deepEqual(store.readRecord('large', '2'), { text: 'שלום 🌍' });
});

test('history larger than the heap can be indexed and queried', () => {
  store.resetStorage();
  fs.mkdirSync(path.join(directory, 'db'), { recursive: true });
  const file = path.join(directory, 'db/history.jsonl');
  const text = 'x'.repeat(1024 * 1024);
  for (let i = 1; i <= 160; i++) fs.appendFileSync(file, JSON.stringify({ seq: i, id: String(i), at: 'now', value: { text, i } }) + '\n');
  const child = spawnSync(process.execPath, ['--max-old-space-size=128', '--expose-gc', '-r', 'ts-node/register/transpile-only', '-e', `
    const assert = require('node:assert/strict');
    const s = require('./src/core/storage');
    s.readValue('account');
    global.gc();
    assert.ok(process.memoryUsage().heapUsed < 80 * 1024 * 1024);
    assert.equal(s.readRecord('history', '80').i, 80);
    assert.equal(s.listRecords('history', {desc:true,limit:1})[0].value.i, 160);
    s.saveRecord('history', '80', {i:800});
    s.closeStorage();
    assert.equal(s.readRecord('history', '80').i, 800);
  `], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: directory }, encoding: 'utf8', timeout: 60000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test('named queries skip unrelated disk payloads and stop when the consumer has a match', () => {
  store.resetStorage();
  store.appendRecord('calls', 'unrelated', 'first', { name: 'large_read', result: 'x'.repeat(1024 * 1024) });
  store.appendRecord('calls', 'older', 'second', { name: 'review', symbol: 'IBM' });
  store.appendRecord('calls', 'newer', 'third', { name: 'review', symbol: 'IBM' });
  for (const reload of [false, true]) {
    if (reload) store.closeStorage();
    store.readValue('account'); // Finish indexing before counting payload reads.
    const original = fs.openSync;
    let reads = 0;
    fs.openSync = function(file, ...args) {
      if (file === path.join(directory, 'db/calls.jsonl')) reads++;
      return original.call(this, file, ...args);
    };
    try {
      for (const row of store.iterateRecords('calls', { name: 'review', desc: true })) {
        assert.equal(row.id, 'newer');
        break;
      }
      assert.equal(reads, 1);
      assert.deepEqual(store.listRecords('calls', { name: 'missing' }), []);
      assert.equal(reads, 1);
    } finally { fs.openSync = original; }
  }
  store.saveRecord('calls', 'newer', { name: 'changed' });
  assert.deepEqual(store.listRecords('calls', { name: 'review' }).map(r => r.id), ['older']);
  assert.throws(() => store.transaction(() => {
    store.saveRecord('calls', 'older', { name: 'changed' });
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(store.listRecords('calls', { name: 'review' })[0].id, 'older');
  store.closeStorage();
  assert.equal(store.listRecords('calls', { name: 'changed' })[0].id, 'newer');
});

test('request queries read only that request\'s payloads, before and after a reload', () => {
  store.resetStorage();
  for (let i = 0; i < 5; i++) store.appendRecord('calls', 'other-' + i, 'x', { name: 'get_bars', requestId: 'r-other', result: 'x'.repeat(1000) });
  store.appendRecord('calls', 'mine', 'y', { name: 'get_entry_plan', requestId: 'r-mine' });
  for (const reload of [false, true]) {
    if (reload) store.closeStorage();
    store.readValue('account');
    const original = fs.openSync;
    let reads = 0;
    fs.openSync = function(file, ...args) {
      if (file === path.join(directory, 'db/calls.jsonl')) reads++;
      return original.call(this, file, ...args);
    };
    try {
      assert.deepEqual(store.listRecords('calls', { requestId: 'r-mine' }).map(r => r.id), ['mine']);
      assert.ok(reads <= 1, 'one payload read, not six');
    } finally { fs.openSync = original; }
  }
});

test('an unfinished last line is dropped at startup; damage elsewhere still stops it', () => {
  store.resetStorage();
  store.appendRecord('torn', 'a', 'first', { n: 1 });
  store.appendRecord('torn', 'b', 'second', { n: 2 });
  store.closeStorage();
  const file = path.join(directory, 'db/torn.jsonl');
  fs.appendFileSync(file, '{"seq":99,"id":"c","at":"third","val');
  assert.deepEqual(store.listRecords('torn').map(r => r.id), ['a', 'b']);
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'), 'the torn tail was removed');
  assert.ok(fs.readdirSync(path.join(directory, 'db')).some(f => f.startsWith('torn.jsonl.torn-')), 'a copy was kept');
  store.appendRecord('torn', 'c', 'third', { n: 3 });
  store.closeStorage();
  assert.deepEqual(store.listRecords('torn').map(r => r.id), ['a', 'b', 'c']);
  // A bad line in the middle is not a torn write.
  store.closeStorage();
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[1] = '{broken';
  fs.writeFileSync(file, lines.join('\n'));
  assert.throws(() => store.listRecords('torn'), /line 2 is not valid JSON/);
  fs.rmSync(file);
  for (const f of fs.readdirSync(path.join(directory, 'db'))) if (f.startsWith('torn.jsonl.torn-')) fs.rmSync(path.join(directory, 'db', f));
  store.closeStorage();
});

test('a failed disk write rolls memory back and is not written again by the next transaction', () => {
  store.resetStorage();
  store.appendRecord('fail', 'kept', 'first', { n: 1 });
  const original = fs.appendFileSync;
  fs.appendFileSync = () => { throw new Error('disk full'); };
  try {
    assert.throws(() => store.saveRecord('fail', 'lost', { n: 2 }), /disk full/);
  } finally { fs.appendFileSync = original; }
  assert.equal(store.readRecord('fail', 'lost'), undefined);
  store.saveRecord('fail', 'next', { n: 3 });
  store.closeStorage();
  assert.deepEqual(store.listRecords('fail').map(r => r.id), ['kept', 'next']);
});

test('a hand edit to the settings file is picked up, settings and playbook together', () => {
  const policy = require('../src/policy/load');
  store.resetStorage();
  policy.loadPolicy();
  const file = path.join(directory, 'db/trade-settings.json');
  const before = policy.getPolicyHash();
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.playbook = 'Prefer quality names.';
  doc.settings.risk.maxPositions = Math.max(1, doc.settings.risk.maxPositions - 1);
  fs.writeFileSync(file, JSON.stringify(doc));
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);
  assert.equal(policy.getPolicy().risk.maxPositions, doc.settings.risk.maxPositions);
  const after = policy.getPolicyHash();
  assert.notEqual(after, before);
  assert.equal(policy.getPolicyHash(), after, 'the hash is stable once both are reloaded');
  // An invalid edit keeps the active settings.
  const kept = policy.getPolicy().risk.maxPositions;
  doc.settings.risk.maxPositions = -5;
  fs.writeFileSync(file, JSON.stringify(doc));
  const later = new Date(Date.now() + 10000);
  fs.utimesSync(file, later, later);
  assert.equal(policy.getPolicy().risk.maxPositions, kept);
});

test('tool-call receipts go to the day folder of their turn; lookups reach today, older days and the old single file', () => {
  store.resetStorage();
  const db = path.join(directory, 'db'), today = require('../src/core/time').etNow().date;
  // Receipts written before day folders existed: the old single file, kept as it is.
  fs.mkdirSync(db, { recursive: true });
  const oldLines = [
    { seq: 1, id: 'ancient:0:0', at: '2026-09-01T15:00:00.000Z', value: { requestId: 'ancient', name: 'get_bars' } },
    { seq: 2, id: 'loose-1', at: '2026-09-01T15:01:00.000Z', value: { name: 'get_quote' } },
  ];
  const oldText = oldLines.map(l => JSON.stringify(l) + '\n').join('');
  fs.writeFileSync(path.join(db, 'tool-calls.jsonl'), oldText);
  store.closeStorage();
  store.appendRecord('requests', 'ancient', '2026-09-01T14:59:00.000Z', { id: 'ancient', role: 'trader', status: 'completed' });
  // A turn that started at 23:59 US Eastern on 2026-11-09 and kept going past midnight.
  store.appendRecord('requests', 'late', '2026-11-10T04:59:00.000Z', { id: 'late', role: 'trader', status: 'running' });
  store.appendRecord('requests', 'now', new Date().toISOString(), { id: 'now', role: 'trader', status: 'running' });
  store.saveRecord('tool-calls', 'late:0:0', { requestId: 'late', name: 'get_bars', startedAt: '2026-11-10T04:59:30.000Z' });
  store.saveRecord('tool-calls', 'late:1:0', { requestId: 'late', name: 'get_quote', startedAt: '2026-11-10T05:10:00.000Z' });
  store.saveRecord('tool-calls', 'now:0:0', { requestId: 'now', name: 'get_bars' });
  store.saveRecord('tool-calls', 'loose-2', { name: 'get_quote' });
  const lines = day => fs.readFileSync(path.join(db, 'days', day, 'tool-calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).id);
  assert.deepEqual(lines('2026-11-09'), ['late:0:0', 'late:1:0'], 'the whole turn stays in the day it started');
  assert.deepEqual(lines(today), ['now:0:0', 'loose-2']);
  assert.equal(fs.readFileSync(path.join(db, 'tool-calls.jsonl'), 'utf8'), oldText, 'the old file is never rewritten');

  // Start-up reads only today's folder: not the older day, not the old single file.
  store.closeStorage();
  const original = fs.openSync, opened = [];
  fs.openSync = function(file, ...args) { opened.push(String(file)); return original.call(this, file, ...args); };
  try {
    store.readValue('account');
    assert.equal(store.readRecord('tool-calls', 'now:0:0').name, 'get_bars');
    assert.equal(store.readRecord('tool-calls', 'loose-2').name, 'get_quote');
    assert.ok(opened.some(f => f.includes(path.join('days', today))), 'today is read');
    assert.ok(!opened.some(f => f.includes('2026-11-09') || f === path.join(db, 'tool-calls.jsonl')), 'older days are not read at start-up');
  } finally { fs.openSync = original; }

  // Lookups by id and by requestId open the day (or old file) they need.
  for (const reload of [false, true]) {
    if (reload) store.closeStorage();
    assert.equal(store.readRecord('tool-calls', 'late:1:0').name, 'get_quote');
    assert.equal(store.readRecord('tool-calls', 'ancient:0:0').name, 'get_bars');
    assert.equal(store.readRecord('tool-calls', 'loose-1').name, 'get_quote');
    assert.deepEqual(store.listRecords('tool-calls', { requestId: 'late' }).map(r => r.id), ['late:0:0', 'late:1:0']);
    assert.deepEqual(store.listRecords('tool-calls', { requestId: 'now' }).map(r => r.id), ['now:0:0']);
    assert.deepEqual(store.listRecords('tool-calls', { requestId: 'ancient' }).map(r => r.id), ['ancient:0:0']);
  }
  // A later update of an old-file receipt goes to a day folder and wins over the old line.
  store.saveRecord('tool-calls', 'loose-1', { name: 'get_quote', note: 'updated' });
  store.closeStorage();
  assert.equal(store.readRecord('tool-calls', 'loose-1').note, 'updated');
  assert.equal(fs.readFileSync(path.join(db, 'tool-calls.jsonl'), 'utf8'), oldText);

  // A listing with no requestId reads only recent days, and says so when it is cut short.
  store.appendRecord('requests', 'month-ago', '2026-10-01T15:00:00.000Z', { id: 'month-ago', role: 'trader', status: 'completed' });
  store.saveRecord('tool-calls', 'month-ago:0:0', { requestId: 'month-ago', name: 'get_bars' });
  store.closeStorage();
  const window = {};
  const recent = store.listRecords('tool-calls', { name: 'get_bars', window }).map(r => r.id);
  assert.ok(recent.includes('now:0:0') && !recent.includes('month-ago:0:0') && !recent.includes('ancient:0:0'));
  assert.equal(window.cutShort, true);
  assert.ok(window.since);
  const all = store.listRecords('tool-calls', { name: 'get_bars', days: Infinity }).map(r => r.id);
  assert.deepEqual(all, ['ancient:0:0', 'month-ago:0:0', 'late:0:0', 'now:0:0']);
});
