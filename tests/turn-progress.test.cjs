// A long turn with big tool results: the trimming note stays ONE note, and the pinned TURN
// PROGRESS block keeps a refused sleep's open list in view until each item is resolved.
// The 2026-11-12 turns grew 217–294 notes in messages[0] and failed at the request cap.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
Object.assign(process.env, { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-turn-progress-')), BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test', ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets' });
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

const schema = { type: 'object', properties: { symbol: { type: 'string' }, reason: { type: 'string' } }, required: [] };
const tools = ['read', 'record_position_review', 'sleep'].map(name => ({ name, description: 'test '.repeat(300), input_schema: schema }));
const BIG = 'x'.repeat(9500);
const REASON = 'PG still trades above its rising 50-day line and the dividend thesis is intact; keep it. '.repeat(3);

test('a 70-round turn keeps one trimming note, a fixed-size first message and the open sleep list', async () => {
  let sleepCalls = 0;
  const registry = new ToolRegistry(tools, async (name, input) => {
    if (name === 'read') return JSON.stringify({ ok: true, symbol: input.symbol, data: BIG });
    if (name === 'record_position_review') return JSON.stringify({ ok: true, symbol: input.symbol, review: { decision: 'hold' } });
    if (name === 'sleep') return ++sleepCalls === 1
      ? JSON.stringify({ ok: false, error: 'Decisions are still open.', open: [{ symbol: 'PG', problem: 'you ran an exit comparison with no review recorded' }] })
      : JSON.stringify({ ok: true });
  });
  const seen = [];
  const plan = round => round === 20 ? ['sleep', {}] : round === 62 ? ['record_position_review', { symbol: 'PG', reason: REASON }]
    : round === 70 ? ['sleep', {}] : ['read', { symbol: 'S' + (round % 7) }];
  const systemPrompt = 'rules '.repeat(3000);
  let round = 0;
  const turn = await runAgentLoop({ context: { requestId: 'long-progress', actorId: 'test', role: 'trader' }, registry,
    provider: { chat: async request => {
      round++;
      const first = request.messages[0].content;
      const texts = first.filter(b => b.type === 'text').map(b => b.text);
      const progress = texts.find(t => t.startsWith('TURN PROGRESS')) ?? '';
      seen.push({ round, size: JSON.stringify(request).length, firstSize: JSON.stringify(first).length - JSON.stringify(progress).length,
        notes: JSON.stringify(request.messages).split('TRIMMED: ').length - 1, progress,
        refusalInView: JSON.stringify(request.messages).includes('Decisions are still open.') });
      const [name, input] = plan(round);
      return { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'c' + round, name, input }], usage: { inputTokens: 1, outputTokens: 1 } };
    } },
    messages: async () => [{ role: 'user', content: [{ type: 'text', text: 'CYCLE CONTEXT ' + 'c'.repeat(20000) }] }],
    systemPrompt, maxTokens: 100, limits: { maxRounds: 200, maxInputTokens: 1e9, warnRounds: 5 } });

  assert.equal(turn.status, 'completed', turn.error);
  assert.equal(round, 70, 'the second sleep ends the turn');
  for (const s of seen) assert.ok(s.size <= REQUEST_CHAR_LIMIT, `round ${s.round}: request ${s.size} chars`);
  const trimmed = seen.filter(s => s.notes > 0);
  assert.ok(trimmed.length > 30, `trimming ran on many rounds (${trimmed.length})`);
  for (const s of trimmed) assert.equal(s.notes, 1, `round ${s.round}: exactly one trimming note`);
  const sizes = trimmed.map(s => s.firstSize);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) < 20, `messages[0] without the progress block stays the same size (${Math.min(...sizes)}–${Math.max(...sizes)})`);

  // The refusal at round 20 stays visible long after its exchange was trimmed away.
  for (const s of seen.filter(s => s.round > 20 && s.round <= 62)) {
    assert.match(s.progress, /sleep was refused[^]*Still open:\n- PG: you ran an exit comparison/, `round ${s.round}`);
  }
  assert.ok(seen.some(s => s.round > 20 && s.round <= 62 && !s.refusalInView), 'the refusal exchange itself was trimmed away');
  // Recorded at round 62: the open item is gone, and the model is told to sleep.
  for (const s of seen.filter(s => s.round > 62)) {
    assert.doesNotMatch(s.progress, /Still open/);
    assert.match(s.progress, /all open decisions are recorded, call sleep/);
    assert.match(s.progress, /Reviews recorded:\n- record_position_review PG decision hold/);
    assert.ok(!s.progress.includes('dividend thesis'), 'the block lists facts and never quotes the reason');
  }
  // Reads are listed once each, with how often they ran.
  assert.match(seen.at(-1).progress, /- read \{"symbol":"S3"\} receipt long-progress:\d+:0, (under 1 min|\d+ min) ago, read \d+ times/);
});

test('compacting replaces the trimming note and keeps one progress block', () => {
  const exchange = i => [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a' + i, name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a' + i, content: 'y'.repeat(5000) }] },
  ];
  let messages = [{ role: 'user', content: [{ type: 'text', text: 'Review' }] }];
  for (let i = 0; i < 30; i++) {
    messages = compactMessages([...messages, ...exchange(i)], 30000, 'TURN PROGRESS round ' + i);
    const first = messages[0].content.filter(b => b.type === 'text').map(b => b.text);
    assert.equal(first.filter(t => t.startsWith('TRIMMED: ')).length, i >= 5 ? 1 : 0, `trim ${i}`);
    assert.deepEqual(first.filter(t => t.startsWith('TURN PROGRESS')), ['TURN PROGRESS round ' + i]);
    assert.ok(JSON.stringify(messages).length <= 30000);
  }
  assert.match(messages[0].content.find(b => b.text?.startsWith('TRIMMED: ')).text, /^TRIMMED: \d+ earlier messages/);
});
