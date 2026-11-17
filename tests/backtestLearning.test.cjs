const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-backtest-learning-')),
  BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
  ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
});
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access in backtest learning test'); };
require('node:http').request = denyNetwork;
require('node:https').request = denyNetwork;
global.fetch = denyNetwork;
const from = name => require(root + '/src/' + name);
const storage = from('core/storage');
storage.useEphemeralStorage();
const base = from('policy/load').getPolicy();
const registry = from('signals/registry');
const { computeSignals, signalTally } = from('strategy/signals');
const barCache = from('backtest/barCache');
const { runBacktest } = from('backtest/engine');
const { renderLearningComparison, tunedThrough, isLearningOff } = from('backtest/learningCompare');

function bars(n) {
  const out = []; let price = 100;
  for (let i = 0; i < n; i++) {
    price *= 1 + (i % 2 ? 0.0005 : -0.0003);
    out.push({ t: new Date(Date.parse('2026-01-01T05:00:00Z') + i * 86400000).toISOString(), o: price, h: price + 1, l: price - 1, c: price, v: 100000 });
  }
  return out;
}

const LEARNED = { id: 'sig-up', name: 'Always Up', code: 'function signal(){ return 1 }' };
function saveLearning() {
  // Built-ins weigh 0, the learned "always +1" signal weighs 1: the "on" composite is exactly +1.
  const weights = Object.fromEntries(registry.BUILT_IN_SIGNALS.map(s => [s.name, 0]));
  weights['Learned: Always Up'] = 1;
  storage.saveValue('learningWeights', weights);
  storage.saveValue('learningLive', { at: '2026-02-10T00:00:00Z', weights, active: [LEARNED] });
  storage.appendRecord('learning-runs', 'run-1', '2026-02-10T00:00:00Z', { id: 'run-1', type: 'run', at: '2026-02-10T00:00:00Z',
    tradingDay: '2026-02-10', weightsBefore: {}, weightsAfter: weights, active: [LEARNED], signals: [], changes: [] });
  return weights;
}

test('explicit setup matches the live composite and ignores the live files', () => {
  const window = bars(80);
  const plain = registry.compositeWith('trend', window, base, registry.LEARNING_OFF);
  assert.equal(plain, signalTally(computeSignals(window, base)).composite, 'nothing saved: same as the live path');
  saveLearning();
  try {
    assert.equal(registry.compositeWith('trend', window, base, registry.LEARNING_OFF), plain, 'off ignores the saved weights');
    assert.equal(registry.compositeWith('trend', window, base, registry.liveSignalSetup()), 1);
    assert.equal(signalTally(computeSignals(window, base)).composite, 1, 'live behaviour unchanged: still reads the saved set');
  } finally { storage.deleteValue('learningWeights'); storage.deleteValue('learningLive'); }
});

test('backtest: learning off ignores saved weights; report shows on vs off, weights and the in-sample cut', async () => {
  const original = barCache.getHistoricalBars;
  const history = bars(120);
  barCache.getHistoricalBars = async () => history;
  const p = { ...base, risk: { ...base.risk, targetVolatilityPct: null }, strategy: { ...base.strategy, watchlist: ['AAPL'], compositeMin: 0.95 } };
  const config = { policy: p, exitMode: 'stop_only', start: '2026-01-01', end: '2026-05-01', slippagePct: 0, initialEquity: 100000, takeProfitRMult: 2 };
  try {
    const before = await runBacktest({ ...config, learning: registry.LEARNING_OFF });
    const weights = saveLearning();
    const setup = registry.liveSignalSetup();
    assert.equal(isLearningOff(setup), false);
    const off = await runBacktest({ ...config, learning: registry.LEARNING_OFF });
    const on = await runBacktest({ ...config, learning: setup });
    assert.deepEqual(off.trades, before.trades, 'the off run is the same with or without saved weights');
    assert.ok(on.trades.length > 0, 'the on run uses the learned set');
    assert.notDeepEqual(on.trades, off.trades);
    assert.deepEqual((await runBacktest(config)).trades, on.trades, 'no setup given = the live set');

    assert.equal(tunedThrough(setup), '2026-02-10');
    assert.equal(tunedThrough(registry.LEARNING_OFF), null);
    const md = renderLearningComparison({ start: config.start, end: config.end, initialEquity: 100000, off, on, onSetup: setup, tunedThrough: tunedThrough(setup) });
    assert.match(md, /## Learning on vs off/);
    assert.match(md, /Off: weights every signal 1; learned signals: none/);
    assert.match(md, /learned signals: Always Up/);
    for (const [name, w] of Object.entries(weights)) assert.ok(md.includes(`${name} ${w}`), `weight ${name} printed`);
    assert.match(md, /in-sample through 2026-02-10/);
    assert.match(md, /On, after 2026-02-10 \(out-of-sample\)/);
    assert.match(md, /Off, after 2026-02-10/);
  } finally {
    barCache.getHistoricalBars = original;
    storage.deleteValue('learningWeights'); storage.deleteValue('learningLive');
  }
});
