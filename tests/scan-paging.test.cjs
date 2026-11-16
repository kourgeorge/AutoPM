const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
const root = path.resolve(__dirname, '..');
Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-scan-paging-')),
  BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
  ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
});
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access in scan paging test'); };
require('node:http').request = require('node:https').request = global.fetch = denyNetwork;
const from = name => require(root + '/src/' + name);
const storage = from('core/storage'), state = from('state/state'), policy = from('policy/load');
const traderTools = from('tools/traderTools'), decisionTools = from('tools/decisionTools');
const { LARGE_PAGE_CHAR_BUDGET } = from('tools/paging');
const { REQUEST_CHAR_LIMIT } = from('core/modelBudget');
const { agentContext } = from('core/agentContext');
const { logger } = from('core/logger');
for (const name of ['info', 'warn', 'error', 'trade', 'tool']) logger[name] = () => {};

beforeEach(() => {
  storage.resetStorage(); policy.loadPolicy();
  state.updateState({ positionSnapshots: {}, paused: false });
});
after(() => storage.closeStorage());

const signal = (name, i) => ({ name, score: (i % 7) / 10, reason: `${name} measured over the last twenty sessions for symbol ${i}; the trend is still intact and volume confirms it.` });
const longText = i => `Insufficient data for SYM${i}: fewer than fifty completed sessions are available, so no trend signal can be measured honestly yet.`;

/** A wide, realistic scan row: full signals, summaries and risk messages. */
const scanRow = i => ({
  symbol: 'SYM' + i, price: 100 + i, priceStale: i % 10 === 0, priceStaleReason: i % 10 === 0 ? `Last trade for SYM${i} is older than the allowed quote age of five minutes.` : null,
  signals: ['momentum', 'trend', 'breakout', 'volume', 'relativeStrength'].map(n => signal(n, i)),
  tally: { composite: (i % 13) / 13, bullish: 3, bearish: 1, neutral: 1 },
  summary: `SYM${i} shows a steady uptrend with rising volume; three of five trend signals agree and none contradicts strongly.`,
  reversal: { chasing: i % 5 === 0, score: -0.2, reason: 'Price is well above its recent average.' },
  meanReversionSignals: ['rsiStretch', 'bandTouch'].map(n => signal(n, i)),
  meanReversionTally: { composite: i % 11 ? -(i % 11) / 11 : 0, bullish: 0, bearish: 1, neutral: 1 },
  meanReversionSummary: `SYM${i} is not stretched far from its mean; the mean-reversion family has nothing strong to say.`,
  atr: 2.5, rsi: 55.5, emaFast: 101, emaSlow: 99, emaCrossedUp: true,
  notScored: i % 25 === 0 ? longText(i) : null,
  riskFit: { allowed: i % 3 !== 0, maxQty: i % 3 ? 10 : 0, qty: 10, volatilityBeforePct: 10, volatilityAfterPct: 11, limits: { maxPositionPct: 10 },
    violations: i % 3 ? [] : [{ rule: 'sectorCap', message: `Adding SYM${i} would put the Technology sector above its 30% cap of account equity.` }],
    caveats: ['Risk budget only; execution rechecks every entry rule.'] },
  riskAdjustedScore: i % 3 ? (i % 13) / 15 : null,
});

const run = (tool, input) => agentContext.run({ role: 'trader', requestId: 'scan-paging', actorId: 'trader' }, () => tool(input));

test('a 150-symbol scan reads in at most 3 compact pages, every symbol once, no text shortened', async () => {
  const rows = Array.from({ length: 150 }, (_, i) => scanRow(i));
  storage.saveRecord('tool-calls', 'scan-150', { name: 'get_watchlist_scan', input: {},
    snapshot: { kind: 'get_watchlist_scan', data: { tickAt: new Date().toISOString(), ageMs: 1000, heldExcluded: [], rows,
      caveats: ['Signals are measured heuristics, not expected returns.'] } } });
  const seen = [];
  let offset = 0, calls = 0;
  while (offset !== null) {
    const text = await run(input => traderTools.executeTraderTool('get_watchlist_scan', input), { snapshotId: 'scan-150', offset });
    calls++;
    assert.ok(text.length <= LARGE_PAGE_CHAR_BUDGET + 2000, 'a page stays near its budget');
    assert.ok(text.length < REQUEST_CHAR_LIMIT / 4, 'a page leaves most of the request for the conversation');
    const page = JSON.parse(text);
    seen.push(...page.rows); offset = page.nextOffset;
    assert.ok(calls <= 3, 'too many pages for a normal watchlist');
  }
  assert.ok(calls <= 3);
  assert.deepEqual(seen.map(r => r.symbol), rows.map(r => r.symbol), 'every symbol exactly once, in order');
  for (const [i, r] of seen.entries()) {
    const src = rows[i];
    assert.equal(r.composite, src.tally.composite);
    assert.equal(r.meanReversionComposite, src.meanReversionTally.composite);
    assert.equal(r.riskAdjustedScore, src.riskAdjustedScore);
    assert.equal(r.price, src.price); assert.equal(r.priceStale, src.priceStale);
    assert.equal(r.rsi, src.rsi); assert.equal(r.atr, src.atr);
    assert.equal(r.riskFit.allowed, src.riskFit.allowed); assert.equal(r.riskFit.maxQty, src.riskFit.maxQty);
    // Text fields that are kept are kept whole.
    if (src.notScored) assert.equal(r.notScored, src.notScored);
    if (src.priceStale) assert.equal(r.priceStaleReason, src.priceStaleReason);
    assert.equal(r.signals, undefined, 'full evidence stays behind details:true');
  }

  // details:true still returns the full rows unchanged, from the same snapshot.
  const detailed = [];
  offset = 0;
  while (offset !== null) {
    const page = JSON.parse(await run(input => traderTools.executeTraderTool('get_watchlist_scan', input), { snapshotId: 'scan-150', offset, details: true }));
    detailed.push(...page.rows); offset = page.nextOffset;
  }
  assert.deepEqual(detailed, rows);
});

test('get_market_context for a 150-symbol watchlist reads in at most 3 pages', async () => {
  const rows = Array.from({ length: 150 }, (_, i) => ({ symbol: 'SYM' + i, sector: 'Technology', asOf: '2026-11-11', source: 'alpaca',
    return1dPct: 0.5, return5dPct: 1.25, return20dPct: -3.5, aboveEma50: i % 2 === 0 }));
  storage.saveRecord('tool-calls', 'ctx-150', { name: 'get_market_context', input: {},
    snapshot: { kind: 'get_market_context', data: { asOf: '2026-11-11', source: 'derived', universe: rows.map(r => r.symbol), rows,
      caveats: ['Split-adjusted completed sessions, excluding dividends.'] } } });
  const seen = [];
  let offset = 0, calls = 0;
  while (offset !== null) {
    const text = await run(input => decisionTools.executeDecisionTool('get_market_context', input), { snapshotId: 'ctx-150', offset });
    calls++;
    const page = JSON.parse(text);
    seen.push(...page.rows); offset = page.nextOffset;
    assert.ok(calls <= 3);
  }
  assert.deepEqual(seen, rows);
});
