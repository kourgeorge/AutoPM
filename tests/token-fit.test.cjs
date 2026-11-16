// T-25 (docs/research/trader-token-use.md #4, #5, #7): lessons fit the cycle context, a normal
// review stays inline, too-big page limits are clamped, and wrong-id errors name the right id.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
Object.assign(process.env, { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-tokenfit-')),
  BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
  ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets' });
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access in token fit test'); };
require('node:http').request = require('node:https').request = global.fetch = denyNetwork;
const from = name => require('../src/' + name);
const storage = from('core/storage');
const { agentContext } = from('core/agentContext');
const { boundedCycleContext, readSavedResult, SAVED_PAGE_MAX, INLINE_RESULT_LIMIT } = from('agents/savedResults');
const { runAgentLoop } = from('agents/agentLoop');
const { ToolRegistry } = from('agents/toolRegistry');
const evidence = from('journal/evidence');
const { executeDecisionTool } = from('tools/decisionTools');
const { logger } = from('core/logger');
for (const name of ['info', 'warn', 'error', 'trade', 'tool']) logger[name] = () => {};

const context = { role: 'trader', actorId: 'system', requestId: 'fit-test' };
beforeEach(() => storage.resetStorage());
after(storage.closeStorage);

// The shape of the 2026-11-12 contexts: ~30k, with LESSONS (~7.9k) last.
const studied = () => '=== ACCOUNT ===\nequity 100000\n'
  + '=== PORTFOLIO CONTEXT ===\n' + 'position row\n'.repeat(700)
  + '=== PROTECTION ===\n' + 'stop row\n'.repeat(400)
  + '=== RECENT DECISIONS ===\n' + 'decision row\n'.repeat(300)
  + '=== LESSONS — YOUR MEMORY (13) ===\n' + 'lesson: check events before buying.\n'.repeat(220);

test('lessons are in a cycle context that used to overflow the 22k budget', () => {
  const brief = studied();
  assert.ok(brief.length > 22000 && brief.length < 40000, `fixture is ${brief.length} characters`);
  const lessons = brief.slice(brief.indexOf('=== LESSONS'));
  assert.ok(lessons.length > 7000);
  // The old 22k budget left LESSONS out; the default budget now keeps the whole context.
  const old = agentContext.run({ ...context, saved: {} }, () => boundedCycleContext(brief, 22000));
  assert.ok(old.includes(lessons), 'LESSONS is chosen first even when the budget is tight');
  const listed = /Omitted sections: (.*)\n/.exec(old)?.[1] ?? '';
  assert.ok(listed && !listed.includes('LESSONS'), `another section is left out instead: ${listed}`);
  assert.equal(agentContext.run({ ...context, saved: {} }, () => boundedCycleContext(brief)), brief);
});

test('get_saved_context fetches one section by name, whole, in one page', () => {
  const brief = studied(), saved = {};
  const bounded = agentContext.run({ ...context, saved }, () => boundedCycleContext(brief, 16000));
  const [id] = Object.keys(saved);
  assert.ok(bounded.length <= 16000);
  storage.saveRecord('trajectories', context.requestId, { id: context.requestId, saved });
  const page = JSON.parse(readSavedResult('get_saved_context', { snapshotId: id, section: 'portfolio context' }));
  const start = brief.indexOf('=== PORTFOLIO CONTEXT'), end = brief.indexOf('=== PROTECTION');
  assert.equal(page.section, 'PORTFOLIO CONTEXT');
  assert.equal(page.text, brief.slice(start, end));
  assert.equal(page.offset, start); assert.equal(page.sectionEnd, end);
  assert.throws(() => readSavedResult('get_saved_context', { snapshotId: id, section: 'NOPE' }), /Sections: ACCOUNT; PORTFOLIO CONTEXT/);
});

test('a 12k position review is returned inline, not as a receipt note', async () => {
  const review = JSON.stringify({ symbol: 'GE', dossier: 'x'.repeat(12000) });
  assert.ok(review.length > 12000 && review.length < INLINE_RESULT_LIMIT);
  let calls = 0, seen;
  const registry = new ToolRegistry([{ name: 'get_position_review', description: 'test', input_schema: { type: 'object', properties: {}, required: [] } }], async () => review);
  const run = await runAgentLoop({ context: { requestId: 'inline-review', actorId: 'test', role: 'trader' }, registry,
    provider: { chat: async request => {
      if (calls++ === 0) return { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'r1', name: 'get_position_review', input: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
      seen = request.messages.flatMap(m => m.content).find(b => b.type === 'tool_result')?.content;
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'Done' }], usage: { inputTokens: 1, outputTokens: 1 } };
    } }, messages: async () => [], systemPrompt: '', maxTokens: 100 });
  assert.equal(run.status, 'completed');
  assert.equal(seen, review);
});

test('a page limit over the maximum is clamped, not an error', async () => {
  const text = 'abcdefghij'.repeat(5000);
  storage.saveRecord('tool-calls', 'big', { result: text });
  const registry = new ToolRegistry([], async () => '{}');
  const run = input => agentContext.run(context, () => registry.execute('get_tool_result', input)).then(JSON.parse);
  const twelve = await run({ receiptId: 'big', limit: 12000 });
  assert.equal(twelve.ok, undefined, JSON.stringify(twelve).slice(0, 200));
  assert.equal(twelve.text, text.slice(0, 12000));
  const huge = await run({ receiptId: 'big', limit: 50000 });
  assert.equal(huge.text.length, SAVED_PAGE_MAX);
  assert.equal(huge.nextOffset, SAVED_PAGE_MAX);
  assert.ok(JSON.stringify(huge).length < INLINE_RESULT_LIMIT, 'a full page still fits inline');
  assert.equal((await run({ receiptId: 'big', limit: 0 })).ok, false);
});

test('wrong evidence ids name the right evidence id for the symbol', () => {
  const [aapl, msft] = agentContext.run({ ...context, toolCallId: 'aapl-review' }, () => [evidence.recordEvidence('get_position_review', { symbol: 'AAPL' }, 'AAPL')])
    .concat(agentContext.run({ ...context, toolCallId: 'msft-review' }, () => [evidence.recordEvidence('get_position_review', { symbol: 'MSFT' }, 'MSFT')]));
  agentContext.run(context, () => {
    assert.throws(() => evidence.validateEvidenceIds([aapl.id], 'MSFT'),
      e => /different symbol: aapl-review is AAPL evidence/.test(e.message) && e.message.includes('Evidence IDs for MSFT: msft-review (get_position_review)'));
    assert.throws(() => evidence.validateEvidenceIds(['made-up'], 'MSFT'),
      e => /Unknown observation evidence ID: made-up/.test(e.message) && e.message.includes('msft-review'));
    assert.throws(() => evidence.validateEvidenceIds(['made-up'], 'TSLA'), /No evidence for TSLA was found; call get_position_review/);
  });
  assert.equal(msft.id, 'msft-review');
});

test('get_research_updates says which tool a wrong snapshotId belongs to', async () => {
  agentContext.run({ ...context, toolCallId: 'review-1' }, () => evidence.recordEvidence('get_position_review', { symbol: 'AAPL' }, 'AAPL'));
  await assert.rejects(agentContext.run(context, () => executeDecisionTool('get_research_updates', { symbol: 'AAPL', snapshotId: 'review-1' })),
    /Unknown snapshot for this tool: review-1.*belongs to get_position_review, not get_research_updates/);
  await assert.rejects(agentContext.run(context, () => executeDecisionTool('get_research_updates', { symbol: 'AAPL', snapshotId: 'nothing' })),
    /No tool call has that id/);
});
