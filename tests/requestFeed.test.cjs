const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
const root = path.resolve(__dirname, '..');
Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-request-feed-')),
  BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'audit',
  ALPACA_KEY_ID: 'audit', ALPACA_SECRET_KEY: 'audit',
  ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
});
require(root + '/node_modules/ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access in request feed test'); };
require('node:http').request = denyNetwork;
require('node:https').request = denyNetwork;
global.fetch = denyNetwork;
const from = name => require(root + '/src/' + name);
const storage = from('core/storage');
const state = from('state/state');
const { logger } = from('core/logger');
for (const name of ['info', 'warn', 'error', 'trade', 'tool']) logger[name] = () => {};
const commands = from('core/requests');
const traderTools = from('tools/traderTools');
const getRequests = input => traderTools.executeTraderTool('get_requests', input).then(JSON.parse);

beforeEach(() => {
  storage.resetStorage();
  state.updateState({ positionSnapshots: {}, accountId: 'alpaca:paper:audit', paused: false });
});
after(() => storage.closeStorage());

const longText = i => `Review the portfolio, request ${i}. ` + 'Check every holding, its stop, its thesis and the latest news before deciding. '.repeat(6);
function seed(count) {
  for (let i = 0; i < count; i++) {
    const r = commands.enqueueRequest('trader', longText(i), 'system');
    commands.updateRequest(r.id, { status: 'completed', result: 'Reviewed every holding; nothing to do. '.repeat(8), orderIds: ['order-' + i] });
  }
}

test('get_requests with since returns nothing when nothing changed, and shows a new request', async () => {
  seed(5);
  const first = await getRequests({});
  assert.ok(first.cursor, 'first call hands back a cursor');
  assert.ok(first.requests.length > 0);
  const again = await getRequests({ since: first.cursor });
  assert.deepEqual(again.requests, [], 'nothing changed, nothing returned');
  assert.equal(again.unchangedSince, first.cursor);

  const fresh = commands.enqueueRequest('trader', 'Look at AAPL', 'operator');
  const next = await getRequests({ since: first.cursor });
  assert.deepEqual(next.requests.map(r => r.id), [fresh.id], 'only the new request shows up');
  assert.equal(next.requests[0].status, 'queued');
  assert.equal(next.requests[0].title, 'Look at AAPL');

  commands.updateRequest(fresh.id, { status: 'completed', result: 'Done' });
  const changed = await getRequests({ since: next.cursor });
  assert.deepEqual(changed.requests.map(r => [r.id, r.status]), [[fresh.id, 'completed']], 'a status change shows up too');
  assert.deepEqual((await getRequests({ since: changed.cursor })).requests, []);

  const full = await getRequests({ id: fresh.id });
  assert.equal(full.request.result, 'Done', 'one request by id comes back in full');
});

test('the default get_requests result is much smaller than the full list for 200 requests', async () => {
  seed(200);
  const open = commands.enqueueRequest('trader', 'Still waiting', 'operator');
  const compact = JSON.stringify(await getRequests({}));
  const full = JSON.stringify(commands.listRequests(100));
  assert.ok(compact.length * 10 < full.length, `compact ${compact.length} vs full ${full.length}`);
  const parsed = JSON.parse(compact);
  assert.ok(parsed.requests.some(r => r.id === open.id), 'open requests are always listed');
  for (const r of parsed.requests) {
    assert.ok(r.title.length <= 120);
    assert.equal(r.result, undefined, 'the list does not carry full results');
    assert.ok(Array.isArray(r.orderIds));
  }
});

test('a cut-short since page continues from its cursor without skipping changes', async () => {
  const start = (await getRequests({})).cursor ?? '1970-01-01T00:00:00.000Z';
  seed(15);
  const seen = new Set();
  let cursor = start;
  for (let i = 0; i < 10; i++) {
    const page = await getRequests({ since: cursor, limit: 4 });
    if (!page.requests.length) break;
    for (const r of page.requests) seen.add(r.id);
    cursor = page.cursor;
  }
  assert.equal(seen.size, 15);
});
