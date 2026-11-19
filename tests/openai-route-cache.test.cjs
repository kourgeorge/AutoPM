const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-openai-cache-')),
  BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
  ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test',
  ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
});
delete process.env.AI_REASONING_EFFORT;
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access in openai cache test'); };
require('node:http').request = denyNetwork;
require('node:https').request = denyNetwork;
const { OpenAICompatibleProvider, promptCacheKey } = require(root + '/src/core/modelProvider');
const { agentContext } = require(root + '/src/core/agentContext');
const { activeAiConfig, saveAiConnection, aiConnectionStatus } = require(root + '/src/core/aiConnection');

const TOOLS = [
  { name: 'b_tool', description: 'B', input_schema: { type: 'object', properties: {} } },
  { name: 'a_tool', description: 'A', input_schema: { type: 'object', properties: {} } },
];

async function call(cfg, { role, usage, tools = TOOLS, toolChoice } = {}) {
  const realFetch = global.fetch;
  let body;
  global.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: usage ?? { prompt_tokens: 10, completion_tokens: 1 },
    }) };
  };
  try {
    const provider = new OpenAICompatibleProvider({ provider: 'litellm', baseUrl: 'http://proxy.test/v1', model: 'azure/gpt-5.6-luna', apiKey: 'k', maxTokensPerTurn: 100, ...cfg });
    const run = () => provider.chat({ systemPrompt: 'sys', tools, maxTokens: 10, toolChoice,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
    const response = role ? await agentContext.run({ role, requestId: 'r', actorId: 'a' }, run) : await run();
    return { body, response };
  } finally {
    global.fetch = realFetch;
  }
}

test('cached_tokens from the reply is recorded as cachedInputTokens', async () => {
  const { response } = await call({}, { usage: { prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 64 } } });
  assert.equal(response.usage.cachedInputTokens, 64);
  const { response: none } = await call({});
  assert.equal(none.usage.cachedInputTokens, 0);
});

test('prompt_cache_key is sent and stable per role', async () => {
  const a = await call({}, { role: 'trader' }), b = await call({}, { role: 'trader' });
  assert.equal(a.body.prompt_cache_key, 'autotrade-trader');
  assert.equal(JSON.stringify(a.body), JSON.stringify(b.body));
  assert.equal((await call({}, { role: 'assistant' })).body.prompt_cache_key, 'autotrade-assistant');
  assert.equal((await call({}, { role: 'researcher' })).body.prompt_cache_key, 'autotrade-researcher');
  assert.equal(promptCacheKey(), 'autotrade-other');
});

test('tools are sent in a fixed order whatever order they arrive in', async () => {
  const a = await call({}, { role: 'trader' }), b = await call({}, { role: 'trader', tools: [...TOOLS].reverse() });
  assert.deepEqual(a.body.tools.map(t => t.function.name), ['a_tool', 'b_tool']);
  assert.equal(JSON.stringify(a.body), JSON.stringify(b.body));
});

test('default body is unchanged apart from prompt_cache_key', async () => {
  const { body } = await call({}, { role: 'trader', tools: [TOOLS[1]], toolChoice: { type: 'tool', name: 'a_tool' } });
  assert.deepEqual(body, {
    model: 'azure/gpt-5.6-luna',
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'a_tool', description: 'A', parameters: { type: 'object', properties: {} } } }],
    tool_choice: { type: 'function', function: { name: 'a_tool' } },
    max_tokens: 10,
    reasoning_effort: 'none',
    temperature: 0,
    prompt_cache_key: 'autotrade-trader',
  });
});

test("effort 'low' sends reasoning_effort low, no temperature, keeps named tool_choice", async () => {
  const { body } = await call({ reasoningEffort: 'low' }, { role: 'trader', toolChoice: { type: 'tool', name: 'a_tool' } });
  assert.equal(body.reasoning_effort, 'low');
  assert.equal('temperature' in body, false);
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'a_tool' } });
});

test('reasoning effort setting: env default, saved override, validation', () => {
  assert.equal(activeAiConfig().reasoningEffort, 'none');
  process.env.AI_REASONING_EFFORT = 'medium';
  assert.equal(activeAiConfig().reasoningEffort, 'medium');
  saveAiConnection({ reasoningEffort: 'low' });
  assert.equal(activeAiConfig().reasoningEffort, 'low');
  assert.equal(aiConnectionStatus().reasoningEffort, 'low');
  assert.equal(aiConnectionStatus().reasoningEffortSource, 'settings');
  assert.throws(() => saveAiConnection({ reasoningEffort: 'extreme' }), /Reasoning effort/);
  saveAiConnection({ reasoningEffort: null });
  assert.equal(activeAiConfig().reasoningEffort, 'medium');
  delete process.env.AI_REASONING_EFFORT;
});
