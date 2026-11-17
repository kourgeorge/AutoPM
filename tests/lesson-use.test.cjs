const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
const root = path.resolve(__dirname, '..');
Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-lesson-use-')),
  BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
  ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
});
require(root + '/node_modules/ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access in lesson use test'); };
require('node:http').request = require('node:https').request = global.fetch = denyNetwork;
const from = name => require(root + '/src/' + name);
const storage = from('core/storage'), state = from('state/state'), policy = from('policy/load');
const lessons = from('journal/lessons'), lessonUse = from('journal/lessonUse'), journal = from('journal/journal');
const { compareLessons } = from('review/lessonOutcomes');
const { agentContext } = from('core/agentContext');
const { logger } = from('core/logger');
for (const name of ['info', 'warn', 'error', 'trade', 'tool']) logger[name] = () => {};

beforeEach(() => {
  storage.resetStorage(); policy.loadPolicy();
  state.updateState({ positionSnapshots: {}, paused: false });
});
after(() => storage.closeStorage());

const save = (id, text) => storage.saveRecord('lessons', id, { id, at: new Date().toISOString(), category: 'behaviour',
  symbol: null, text, evidenceIds: [], active: true, replacedBy: null, actorId: 'trader' });

test('an entry records the lessons its cycle was shown, and any it cited', () => {
  save('lesson-a', 'Wait for the first 15 minutes before buying.');
  save('lesson-b', 'Do not chase a gap above 5%.');
  const run = (requestId, fn) => agentContext.run({ role: 'trader', requestId, actorId: 'trader' }, fn);
  run('req-1', () => lessonUse.noteLessonsShown('req-1', lessons.lessonsForContext([]).ids));
  const entry = run('req-1', () => journal.recordDecision(journal.decision('entry', 'trader',
    { symbol: 'AAPL', rationale: 'Breakout held after the open, per lesson lesson-a.' })));
  const saved = journal.readDecision(entry.id);
  assert.deepEqual([...saved.lessonsShown].sort(), ['lesson-a', 'lesson-b']);
  assert.deepEqual(saved.lessonsCited, ['lesson-a']);
  // A hold stores only what it cites, not the whole shown list.
  const hold = run('req-1', () => journal.recordDecision(journal.decision('hold', 'trader', { symbol: 'MSFT', rationale: 'Gap of 7%; lesson-b says do not chase.' })));
  assert.equal(journal.readDecision(hold.id).lessonsShown, undefined);
  assert.deepEqual(journal.readDecision(hold.id).lessonsCited, ['lesson-b']);
  // A request that was never shown lessons is untracked, not "without".
  const other = run('req-2', () => journal.recordDecision(journal.decision('entry', 'trader', { symbol: 'IBM', rationale: 'lesson-a' })));
  assert.equal(journal.readDecision(other.id).lessonsShown, undefined);
});

test('compareLessons splits round trips by lesson and warns when the sample is small', () => {
  const trip = (day, pnl, shown, cited = null) => ({ entryAt: `2026-01-${String(day).padStart(2, '0')}T15:00:00Z`,
    grossPnL: pnl, returnPct: pnl / 10, lessonsShown: shown, lessonsCited: cited });
  const report = compareLessons([
    trip(1, -20, []), trip(2, -10, []), trip(3, 30, ['lesson-a'], ['lesson-a']), trip(4, 10, ['lesson-a']), trip(5, 5, null),
  ]);
  assert.equal(report.tracked, 4); assert.equal(report.untracked, 1);
  const a = report.lessons.find(l => l.lessonId === 'lesson-a');
  assert.equal(a.withLesson.trades, 2); assert.equal(a.withLesson.winRate, 100); assert.equal(a.withLesson.expectancy, 20);
  assert.equal(a.withoutLesson.trades, 2); assert.equal(a.withoutLesson.expectancy, -15);
  assert.equal(a.cited.trades, 1);
  assert.equal(a.caveats.length, 2);
});
