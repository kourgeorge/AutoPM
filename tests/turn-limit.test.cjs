// A turn's round and input-token limits (runAgentLoop `limits`). The fake model never stops
// calling tools, so only the limit can end the turn.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
Object.assign(process.env, { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-turn-limit-')), BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test', ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets' });
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access'); };
require('http').request = denyNetwork;
require('https').request = denyNetwork;
global.fetch = denyNetwork;
const storage = require('../src/core/storage');
const { logger } = require('../src/core/logger');
const { runAgentLoop, readTrajectory, compactMessages, TURN_LIMIT_WARNING } = require('../src/agents/agentLoop');
const { ToolRegistry } = require('../src/agents/toolRegistry');
const logged = [];
for (const name of ['info', 'error', 'trade', 'tool']) logger[name] = () => {};
logger.warn = text => { logged.push(text); };

beforeEach(() => { storage.resetStorage(); logged.length = 0; });
after(() => storage.closeStorage());

const registry = () => new ToolRegistry([{ name: 'read', description: 'test', input_schema: { type: 'object', properties: {}, required: [] } }], async () => '{"ok":true}');
/** A model that always asks for one more read, and records whether each request carried the warning. */
function endlessModel(inputTokens = 1) {
  const sawWarning = [];
  const provider = { chat: async request => {
    sawWarning.push(JSON.stringify(request.messages).includes('TURN LIMIT'));
    return { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'call-' + sawWarning.length, name: 'read', input: {} }], usage: { inputTokens, outputTokens: 1 } };
  } };
  return { provider, sawWarning };
}
const start = async () => [{ role: 'user', content: [{ type: 'text', text: 'Review' }] }];

test('a model that never stops is ended at the round limit, warned first', async () => {
  const { provider, sawWarning } = endlessModel();
  const turn = await runAgentLoop({ context: { requestId: 'endless', actorId: 'test', role: 'trader' }, registry: registry(), provider,
    messages: start, systemPrompt: '', maxTokens: 100, limits: { maxRounds: 8, maxInputTokens: 1e9, warnRounds: 3 } });
  assert.equal(turn.status, 'completed', turn.error);
  assert.equal(turn.endReason, 'round_limit');
  assert.equal(turn.rounds, 8);
  assert.equal(sawWarning.length, 8, 'no model call after the limit');
  assert.deepEqual(sawWarning, [false, false, false, false, false, true, true, true], 'warning sent 3 rounds before the end and kept');
  assert.match(turn.text, /round limit/);
  // The last batch of tool calls ran fully; nothing is left half-done.
  assert.equal(turn.messages.at(-1).role, 'user');
  assert.ok(turn.messages.at(-1).content.every(b => b.type === 'tool_result'));
  const saved = readTrajectory('endless');
  assert.equal(saved.endReason, 'round_limit');
  assert.equal(saved.status, 'completed');
  assert.ok(logged.some(t => /round limit/.test(t)), 'the reason is logged');
  // A finished turn is not resumed.
  const again = await runAgentLoop({ context: { requestId: 'endless', actorId: 'test', role: 'trader' }, registry: registry(),
    provider: { chat: async () => { throw new Error('Must not call the model again'); } }, messages: start, systemPrompt: '', maxTokens: 100, limits: { maxRounds: 8, maxInputTokens: 1e9, warnRounds: 3 } });
  assert.equal(again.endReason, 'round_limit');
});

test('the input-token limit also ends the turn, after a warning', async () => {
  const { provider, sawWarning } = endlessModel(100);
  const turn = await runAgentLoop({ context: { requestId: 'heavy', actorId: 'test', role: 'trader' }, registry: registry(), provider,
    messages: start, systemPrompt: '', maxTokens: 100, limits: { maxRounds: 1000, maxInputTokens: 1000, warnRounds: 3 } });
  assert.equal(turn.endReason, 'token_limit');
  assert.equal(turn.rounds, 10);
  assert.equal(sawWarning.indexOf(true), 8, 'warned at 80% of the token budget');
});

test('without limits a turn is not capped and gets no warning', async () => {
  let calls = 0;
  const turn = await runAgentLoop({ context: { requestId: 'free', actorId: 'test', role: 'assistant' }, registry: registry(),
    provider: { chat: async () => ++calls <= 50 ? { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'c' + calls, name: 'read', input: {} }], usage: { inputTokens: 1, outputTokens: 1 } }
      : { stopReason: 'end_turn', content: [{ type: 'text', text: 'Done' }], usage: { inputTokens: 1, outputTokens: 1 } } },
    messages: start, systemPrompt: '', maxTokens: 100 });
  assert.equal(turn.status, 'completed'); assert.equal(turn.endReason, undefined); assert.equal(turn.text, 'Done');
});

test('compacting keeps the warning next to the tool results it was sent with', () => {
  const messages = compactMessages([
    { role: 'user', content: [{ type: 'text', text: 'Review' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '{}' }, { type: 'text', text: TURN_LIMIT_WARNING }] },
  ]);
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[2].content.map(b => b.type), ['tool_result', 'text']);
});
