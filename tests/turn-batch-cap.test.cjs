// A big tool batch must not push a trader request over the request cap (T-71). Trimming stops
// at 3 messages, so the largest new results are swapped for receipt pointers instead.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
Object.assign(process.env, { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-turn-batch-')), BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test', ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets' });
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access'); };
require('http').request = denyNetwork;
require('https').request = denyNetwork;
global.fetch = denyNetwork;
const storage = require('../src/core/storage');
const { logger } = require('../src/core/logger');
const { runAgentLoop, compactMessages } = require('../src/agents/agentLoop');
const { ToolRegistry } = require('../src/agents/toolRegistry');
const { REQUEST_CHAR_LIMIT } = require('../src/core/modelBudget');
for (const name of ['info', 'warn', 'error', 'trade', 'tool']) logger[name] = () => {};

beforeEach(() => storage.resetStorage());
after(() => storage.closeStorage());

const pairsOk = messages => {
  const uses = messages.flatMap(m => m.content.filter(b => b.type === 'tool_use').map(b => b.id));
  const results = messages.flatMap(m => m.content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id));
  assert.deepEqual([...results].sort(), [...uses].sort(), 'every tool_use keeps its tool_result');
};

test('a 15-result batch over the limit is fitted by swapping the largest results for receipt pointers', () => {
  const limit = 97_973, progress = 'TURN PROGRESS: 15 reads this turn';
  const calls = Array.from({ length: 15 }, (_, i) => ({ type: 'tool_use', id: 'c' + i, name: 'read', input: { symbol: 'S' + i } }));
  const results = calls.map((c, i) => ({ type: 'tool_result', tool_use_id: c.id, receiptId: 'turn:1:' + i,
    content: JSON.stringify({ ok: true, data: 'y'.repeat(10_000 - 30 + i) }) }));
  const messages = compactMessages([
    { role: 'user', content: [{ type: 'text', text: 'c'.repeat(35_000) }] },
    { role: 'assistant', content: calls },
    { role: 'user', content: results },
  ], limit, progress);
  const pinned = JSON.stringify([{ type: 'text', text: progress }]).length;
  assert.ok(JSON.stringify(messages).length <= limit - pinned, `fits: ${JSON.stringify(messages).length}`);
  pairsOk(messages);
  const out = messages.flatMap(m => m.content.filter(b => b.type === 'tool_result'));
  const swapped = out.filter(b => JSON.parse(b.content).truncated);
  assert.ok(swapped.length > 0 && swapped.length < 15, `some, not all, swapped: ${swapped.length}`);
  for (const b of swapped) {
    const note = JSON.parse(b.content);
    assert.equal(note.receiptId, b.receiptId);
    assert.match(note.note, /get_tool_result/);
  }
  // Largest first: every swapped result was at least as big as every one kept inline.
  const size = id => results.find(r => r.tool_use_id === id).content.length;
  const kept = out.filter(b => !JSON.parse(b.content).truncated);
  assert.ok(Math.min(...swapped.map(b => size(b.tool_use_id))) >= Math.max(...kept.map(b => size(b.tool_use_id))));
  // The cycle message is untouched.
  assert.equal(messages[0].content[0].text, 'c'.repeat(35_000));
});

test('a turn whose first batch returns 15 results of 12k stays under the request cap and reaches sleep', async () => {
  // A system prompt and tool list of about 100k, as for the trader.
  const schema = { type: 'object', properties: { symbol: { type: 'string' } }, required: [] };
  const tools = ['read', 'sleep'].map(name => ({ name, description: 'd'.repeat(30_000), input_schema: schema }));
  const registry = new ToolRegistry(tools, async (name, input) => name === 'sleep' ? JSON.stringify({ ok: true })
    : JSON.stringify({ ok: true, symbol: input.symbol, data: 'z'.repeat(12_000) }));
  const sizes = [];
  let round = 0;
  const provider = { chat: async params => {
    sizes.push(JSON.stringify(params).length);
    round++;
    const content = round === 1
      ? Array.from({ length: 15 }, (_, i) => ({ type: 'tool_use', id: 'r' + i, name: 'read', input: { symbol: 'S' + i } }))
      : [{ type: 'tool_use', id: 'sleep', name: 'sleep', input: {} }];
    return { stopReason: 'tool_use', content, usage: { inputTokens: 1, outputTokens: 1 } };
  } };
  const turn = await runAgentLoop({ context: { requestId: 'batch', actorId: 'test', role: 'trader' }, registry, provider,
    messages: async () => [{ role: 'user', content: [{ type: 'text', text: 'c'.repeat(35_000) }] }],
    systemPrompt: 's'.repeat(40_000), maxTokens: 100 });
  assert.equal(turn.status, 'completed', turn.error);
  assert.doesNotMatch(turn.error ?? '', /request limit/);
  assert.equal(sizes.length, 2);
  for (const s of sizes) assert.ok(s <= REQUEST_CHAR_LIMIT, `request ${s} over the cap`);
  pairsOk(turn.messages);
});

test('a first message too big on its own fails before the model is called, naming it', async () => {
  const registry = new ToolRegistry([{ name: 'sleep', description: 't', input_schema: { type: 'object', properties: {}, required: [] } }], async () => '{"ok":true}');
  let called = 0;
  const turn = await runAgentLoop({ context: { requestId: 'huge', actorId: 'test', role: 'trader' }, registry,
    provider: { chat: async () => { called++; throw new Error('Must not be called'); } },
    messages: async () => [{ role: 'user', content: [{ type: 'text', text: 'c'.repeat(REQUEST_CHAR_LIMIT) }] }],
    systemPrompt: '', maxTokens: 100 });
  assert.equal(called, 0);
  assert.equal(turn.status, 'failed');
  assert.match(turn.error, /first message/);
});
