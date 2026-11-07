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
