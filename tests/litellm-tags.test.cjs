const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-litellm-tags-')),
  BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
  ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test',
  ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
});
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access in litellm tags test'); };
require('node:http').request = denyNetwork;
require('node:https').request = denyNetwork;
const { LITELLM_TAGS, OpenAICompatibleProvider, AnthropicProvider } = require(root + '/src/core/modelProvider');

test('OpenAI-compatible requests carry the x-litellm-tags header', async () => {
  const realFetch = global.fetch;
  let sent;
  global.fetch = async (url, init) => {
    sent = { url, init };
    return { ok: true, status: 200, json: async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }) };
  };
  try {
    const provider = new OpenAICompatibleProvider({ provider: 'litellm', baseUrl: 'http://proxy.test/v1', model: 'm', apiKey: 'k' });
    await provider.chat({ systemPrompt: 's', tools: [], maxTokens: 10,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  } finally {
    global.fetch = realFetch;
  }
  assert.ok(LITELLM_TAGS.length > 0);
  assert.equal(sent.url, 'http://proxy.test/v1/chat/completions');
  assert.equal(sent.init.headers['x-litellm-tags'], LITELLM_TAGS);
});

test('the Anthropic client sends x-litellm-tags as a default header', () => {
  const provider = new AnthropicProvider({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'test' });
  assert.equal(provider.client._options.defaultHeaders['x-litellm-tags'], LITELLM_TAGS);
});
