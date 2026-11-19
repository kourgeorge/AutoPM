const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
const root = path.resolve(__dirname, '..');
Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-lessons-paging-')),
  BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
  ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
});
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access in lessons paging test'); };
require('node:http').request = require('node:https').request = global.fetch = denyNetwork;
const from = name => require(root + '/src/' + name);
const storage = from('core/storage'), state = from('state/state'), policy = from('policy/load');
const lessons = from('journal/lessons');
const traderTools = from('tools/traderTools');
const { agentContext } = from('core/agentContext');
const { logger } = from('core/logger');
for (const name of ['info', 'warn', 'error', 'trade', 'tool']) logger[name] = () => {};

beforeEach(() => {
  storage.resetStorage(); policy.loadPolicy();
  state.updateState({ positionSnapshots: {}, paused: false });
});
after(() => storage.closeStorage());

const save = (n, extra = {}) => storage.saveRecord('lessons', `lesson-${n}`, {
  id: `lesson-${n}`, at: new Date(Date.UTC(2026, 0, 1) + n * 60000).toISOString(), category: 'behaviour', symbol: null,
  text: `Behaviour lesson number ${n}.`, evidenceIds: [], active: true, replacedBy: null, actorId: 'trader', ...extra });

const save120 = () => {
  // The lesson about the held stock is saved first, so it is the oldest of all 120.
  save(1, { category: 'stock', symbol: 'ORCL', text: 'ORCL drifts lower into earnings; do not add the week before.' });
  for (let n = 2; n <= 120; n++) save(n);
};

test('an old lesson about a stock in play is still shown when there are more than 100 active lessons', () => {
  save120();
  const block = lessons.lessonsForContext(['ORCL']);
  assert.equal(block.total, 120);
  assert.match(block.text, /- \[ORCL\] ORCL drifts lower into earnings; do not add the week before\./);
  assert.equal(block.shown, 30);
});

test('get_lessons pages past the first 100 lessons and reports the full total', async () => {
  save120();
  const run = input => agentContext.run({ role: 'trader', requestId: 'paging', actorId: 'trader' },
    () => traderTools.executeTraderTool('get_lessons', input));
  const first = JSON.parse(await run({}));
  assert.equal(first.count, 100); assert.equal(first.total, 120); assert.equal(first.nextOffset, 100);
  assert.ok(!first.lessons.some(l => l.id === 'lesson-11'));
  const second = JSON.parse(await run({ offset: first.nextOffset }));
  assert.equal(second.count, 20); assert.equal(second.nextOffset, null);
  // Newest first: lesson #110 counted from the newest is lesson-11.
  assert.ok(second.lessons.some(l => l.id === 'lesson-11'));
  assert.ok(second.lessons.some(l => l.id === 'lesson-1' && l.symbol === 'ORCL'));
  assert.deepEqual(lessons.listLessons(100, true, {}, 109).map(l => l.id), ['lesson-11', 'lesson-10', 'lesson-9', 'lesson-8', 'lesson-7', 'lesson-6', 'lesson-5', 'lesson-4', 'lesson-3', 'lesson-2', 'lesson-1']);
});
