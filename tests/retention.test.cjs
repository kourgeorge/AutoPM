const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-retention-'));
Object.assign(process.env, { DATA_DIR: directory, BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
  ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets' });
require('ts-node/register');
const storage = require('../src/core/storage');
const { agentContext } = require('../src/core/agentContext');
const { recordPage } = require('../src/tools/paging');
const retention = require('../src/journal/retention');
const { logger } = require('../src/core/logger');
const logged = [];
logger.info = line => logged.push(line);
after(() => { storage.closeStorage(); fs.rmSync(directory, { recursive: true, force: true }); });

const db = path.join(directory, 'db');
const today = require('../src/core/time').etNow().date;
const daysBack = n => { const [y, m, d] = today.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10); };
const rows = Array.from({ length: 30 }, (_, i) => ({ symbol: 'S' + i, composite: i }));

/** A turn on `day`, and a scan in it whose snapshot goes to that day's folder. */
function scan(request, round, input = {}) {
  const id = `${request}:${round}:0`;
  storage.saveRecord('tool-calls', id, { name: 'get_watchlist_scan', role: 'trader', requestId: request, input });
  agentContext.run({ role: 'trader', actorId: 'system', requestId: request, toolCallId: id }, () => recordPage('get_watchlist_scan', { rows }, 'rows', input));
  return id;
}
/** Every file under db/ with its contents, to tell whether a run changed anything. */
function tree(dir = db, out = {}) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) { out[path.relative(db, file) + '/'] = ''; tree(file, out); }
    else out[path.relative(db, file)] = fs.readFileSync(file, 'utf8');
  }
  return out;
}

test('settings: defaults, saved values and plain-English limits', () => {
  storage.resetStorage();
  assert.deepEqual(retention.retentionSettings(), { snapshotDays: 2, receiptDays: 90 });
  assert.deepEqual(retention.saveRetentionSettings({ snapshotDays: 3 }), { snapshotDays: 3, receiptDays: 90 });
  storage.closeStorage();
  assert.deepEqual(retention.retentionSettings(), { snapshotDays: 3, receiptDays: 90 });
  assert.throws(() => retention.saveRetentionSettings({ snapshotDays: 0 }), /Days to keep snapshot files must be a whole number/);
  assert.throws(() => retention.saveRetentionSettings({ receiptDays: 2.5 }), /Days to keep tool-call receipts/);
});

test('old snapshots and receipts are deleted after their limits; evidence a decision cites is kept and still read by id; a second run changes nothing', () => {
  storage.resetStorage();
  const old = daysBack(100), recent = daysBack(5), yesterday = daysBack(1);
  for (const [id, day] of [['r100', old], ['r5', recent], ['r1', yesterday]])
    storage.appendRecord('requests', id, `${day}T17:00:00.000Z`, { id, role: 'trader', status: 'completed' });
  // The old single receipts file: never touched.
  const oldFileText = JSON.stringify({ seq: 1, id: 'ancient', at: '2026-01-01T00:00:00.000Z', value: { name: 'get_bars' } }) + '\n';
  fs.writeFileSync(path.join(db, 'tool-calls.jsonl'), oldFileText);

  // 100 days ago: a scan and its later page, which the journal cites; an uncited scan and read.
  const cited = scan('r100', 0);
  storage.saveRecord('tool-calls', 'r100:1:0', { name: 'get_watchlist_scan', role: 'trader', requestId: 'r100', input: { snapshotId: cited, offset: 5 } });
  const dropped = scan('r100', 2);
  storage.saveRecord('tool-calls', 'r100:3:0', { name: 'get_bars', role: 'trader', requestId: 'r100', input: { symbol: 'AAA' } });
  storage.appendRecord('journal', 'skip-1', `${old}T17:05:00.000Z`, { id: 'skip-1', at: `${old}T17:05:00.000Z`, kind: 'skip', actor: 'trader',
    symbol: 'AAA', rationale: 'wait: the scan ranked it below three others', observationIds: ['r100:1:0'] });
  // 5 days ago: a candidate review citing a scan; another scan nobody cites.
  const reviewed = scan('r5', 0), unreviewed = scan('r5', 1);
  storage.saveRecord('tool-calls', 'r5:2:0', { name: 'record_candidate_review', role: 'trader', requestId: 'r5', input: {},
    result: JSON.stringify({ ok: true, review: { id: 'candidate-r5:2:0', symbol: 'BBB', decision: 'wait', evidenceIds: [reviewed], snapshotId: reviewed } }) });
  // Yesterday: inside the 2-day snapshot limit.
  const fresh = scan('r1', 0);
  const journalText = fs.readFileSync(path.join(db, 'journal.jsonl'), 'utf8');
  assert.ok(fs.existsSync(path.join(db, 'days', old, 'snapshots')));

  const first = retention.cleanupDayFolders();
  // (a) Past their limits: the 100-day folder is gone; 5 days keeps receipts but not snapshots.
  assert.equal(fs.existsSync(path.join(db, 'days', old)), false, 'old day folder deleted');
  assert.equal(fs.existsSync(path.join(db, 'days', recent, 'snapshots')), false, 'snapshots past 2 days deleted');
  assert.ok(fs.existsSync(path.join(db, 'days', recent, 'tool-calls.jsonl')), 'receipts within 90 days kept');
  assert.ok(fs.existsSync(path.join(db, 'days', yesterday, 'snapshots')), 'yesterday\'s snapshots kept');
  assert.deepEqual(first.receiptsDeleted, [{ day: old, receipts: 4 }]);
  assert.deepEqual(first.snapshotsDeleted.map(s => s.day), [old, recent]);
  assert.equal(storage.readRecord('tool-calls', 'r100:3:0'), undefined);
  assert.equal(storage.readRecord('tool-calls', dropped), undefined);
  assert.throws(() => recordPage('get_watchlist_scan', { rows: [] }, 'rows', { snapshotId: unreviewed }), /Unknown snapshot/);
  // (b) What decisions cite survives in db/evidence and still pages by id, before and after a reload.
  assert.deepEqual(first.kept.map(k => k.id).sort(), [cited, 'r100:1:0', reviewed].sort());
  assert.match(first.kept.find(k => k.id === 'r100:1:0').reason, /cited by skip decision skip-1/);
  assert.match(first.kept.find(k => k.id === cited).reason, /through r100:1:0/);
  assert.match(first.kept.find(k => k.id === reviewed).reason, /saved record_candidate_review/);
  for (const reload of [false, true]) {
    if (reload) storage.closeStorage();
    assert.deepEqual(recordPage('get_watchlist_scan', { rows: [] }, 'rows', { snapshotId: 'r100:1:0', offset: 25 }).rows, rows.slice(25));
    assert.deepEqual(recordPage('get_watchlist_scan', { rows: [] }, 'rows', { snapshotId: reviewed, offset: 0 }).rows.length > 0, true);
    assert.equal(storage.readRecord('tool-calls', 'r100:1:0').input.snapshotId, cited);
    assert.equal(storage.readRecord('tool-calls', fresh).snapshot.file, `days/${yesterday}/snapshots/${fresh.replace(/[^\w.-]/g, '_')}.json`);
  }
  assert.ok(fs.existsSync(path.join(db, 'evidence', 'r100_1_0.json')));
  // Never touched: the journal and the old single receipts file.
  assert.equal(fs.readFileSync(path.join(db, 'journal.jsonl'), 'utf8'), journalText);
  assert.equal(fs.readFileSync(path.join(db, 'tool-calls.jsonl'), 'utf8'), oldFileText);
  // One log line, naming what was deleted and what was kept, and why.
  const line = logged.at(-1);
  assert.match(line, /^\[Cleanup\] deleted snapshots of .*receipts of .*kept 3 in db\/evidence: .*cited by skip decision skip-1/);

  // (c) A second run finds nothing to do and writes nothing.
  const before = tree();
  const second = retention.cleanupDayFolders();
  assert.deepEqual([second.snapshotsDeleted, second.receiptsDeleted, second.kept], [[], [], []]);
  assert.deepEqual(tree(), before);
  assert.match(logged.at(-1), /^\[Cleanup\] nothing to delete/);
});

test('a held position whose only review is in a cleaned day folder still lists that review, in time order, after a reload', () => {
  storage.resetStorage();
  const { upsertPositionSnapshot } = require('../src/state/state');
  const { listReviews } = require('../src/journal/reviews');
  const { latestPositionReview } = require('../src/journal/thesis');
  const old = daysBack(120), recent = daysBack(3);
  for (const [id, day] of [['p120', old], ['p3', recent]])
    storage.appendRecord('requests', id, `${day}T15:00:00.000Z`, { id, role: 'trader', status: 'completed' });
  upsertPositionSnapshot('CCC', { openedAt: `${old}T14:00:00.000Z`, entryDecisionId: 'entry-ccc' });
  const review = { id: 'review-p120:0:0', at: `${old}T15:01:00.000Z`, symbol: 'CCC', entryDecisionId: 'entry-ccc', decision: 'hold' };
  storage.saveRecord('tool-calls', 'p120:0:0', { name: 'record_position_review', role: 'trader', requestId: 'p120', input: {},
    result: JSON.stringify({ ok: true, review }) });
  storage.saveRecord('tool-calls', 'p3:0:0', { name: 'record_candidate_review', role: 'trader', requestId: 'p3', input: {},
    result: JSON.stringify({ ok: true, review: { id: 'candidate-p3:0:0', at: `${recent}T15:01:00.000Z`, symbol: 'DDD', decision: 'wait' } }) });

  const report = retention.cleanupDayFolders();
  assert.deepEqual(report.receiptsDeleted.map(r => r.day), [old]);
  assert.equal(fs.existsSync(path.join(db, 'days', old)), false);
  for (const reload of [false, true]) {
    if (reload) storage.closeStorage();
    assert.deepEqual(listReviews('record_position_review', () => true, Infinity, Infinity).map(r => r.id), [review.id]);
    assert.deepEqual(listReviews('record_position_review', () => true, Infinity, 30), [], 'outside a 30-day window');
    assert.equal(latestPositionReview('CCC')?.id, review.id);
    assert.deepEqual(storage.listRecords('tool-calls', { requestId: 'p120' }).map(r => r.id), ['p120:0:0']);
    // Kept and live receipts together, oldest first, each listed once.
    assert.deepEqual(storage.listRecords('tool-calls', { days: Infinity }).map(r => r.id), ['p120:0:0', 'p3:0:0']);
    assert.deepEqual(storage.listRecords('tool-calls', { days: Infinity, desc: true, limit: 1 }).map(r => r.id), ['p3:0:0']);
  }
  // Evidence saved before the index existed is still listed.
  fs.rmSync(path.join(db, 'evidence', 'index.jsonl'));
  storage.closeStorage();
  assert.equal(latestPositionReview('CCC')?.id, review.id);
});
