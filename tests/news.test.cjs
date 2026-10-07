const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
Object.assign(process.env, {
  BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'audit',
  ALPACA_KEY_ID: 'audit', ALPACA_SECRET_KEY: 'audit',
  ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
});
require(root + '/node_modules/ts-node/register');
const { shapeYahooNews } = require(root + '/src/collect/yahoo');
const { executeResearchTool, RESEARCH_TOOL_DEFINITIONS } = require(root + '/src/tools/researchTools');

test('Yahoo news keeps only stories tagged with the ticker, newest first', () => {
  const raw = [
    { title: 'Market wrap', providerPublishTime: '2026-10-07T15:00:00Z', relatedTickers: ['^GSPC', 'NVDA'] },
    { title: 'Older AAPL', link: 'https://x/1', publisher: 'P', providerPublishTime: '2026-10-06T10:00:00Z', relatedTickers: ['AAPL'] },
    { title: 'Newer AAPL', providerPublishTime: new Date('2026-10-07T12:00:00Z'), relatedTickers: ['MSFT', 'AAPL'] },
    { title: 'No tickers' },
  ];
  const out = shapeYahooNews('AAPL', raw, 5);
  assert.deepEqual(out.map(n => n.title), ['Newer AAPL', 'Older AAPL']);
  assert.equal(out[1].url, 'https://x/1');
  assert.equal(out[1].publishedAt, '2026-10-06T10:00:00.000Z');
  assert.equal(shapeYahooNews('AAPL', raw, 1).length, 1);
});

test('Yahoo news matches crypto across spellings', () => {
  const out = shapeYahooNews('BTC-USD', [{ title: 'BTC', relatedTickers: ['BTC-USD'] }], 5);
  assert.equal(out.length, 1);
});

test('web_search without a Tavily key reports an error instead of empty results', async () => {
  const saved = process.env.TAVILY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  try {
    const r = JSON.parse(await executeResearchTool('web_search', { query: 'x' }));
    assert.deepEqual(r.results, []);
    assert.match(r.error, /TAVILY_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.TAVILY_API_KEY = saved;
  }
});

test('the separate Yahoo tool is gone; get_news carries Yahoo instead', () => {
  assert.ok(!RESEARCH_TOOL_DEFINITIONS.some(t => t.name === 'get_ticker_news'));
  const { ALPACA_DATA_TOOL_DEFINITIONS } = require(root + '/src/tools/alpacaDataTools');
  assert.match(ALPACA_DATA_TOOL_DEFINITIONS.find(t => t.name === 'get_news').description, /Yahoo/);
});
