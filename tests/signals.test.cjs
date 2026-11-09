const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-signals-')),
  BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
  ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
});
require(root + '/node_modules/ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access in signal test'); };
require('node:http').request = denyNetwork;
require('node:https').request = denyNetwork;
global.fetch = denyNetwork;
const from = name => require(root + '/src/' + name);
from('core/storage').useEphemeralStorage();
const policy = from('policy/load').getPolicy();
const registry = from('signals/registry');
const { Signal, SignalContext } = from('signals/signal');
const { SandboxedSignal } = from('signals/sandboxed');
const { checkSignal, syntheticBars } = from('signals/testkit');
const { computeSignals, signalTally } = from('strategy/signals');
const { computeMeanReversionSignals } = from('strategy/meanReversion');
const { crossSectionalComposite } = from('signals/builtin/crossSectional');

// Every registered signal gets the shared rules — a new signal is tested by being registered.
for (const signal of registry.BUILT_IN_SIGNALS) {
  test(`signal rules: ${signal.name}`, () => {
    const { failures } = checkSignal(signal, policy);
    assert.deepEqual(failures, []);
  });
}

test('signal ids and names are unique', () => {
  const ids = registry.BUILT_IN_SIGNALS.map(s => s.id), names = registry.BUILT_IN_SIGNALS.map(s => s.name);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(names).size, names.length);
});

// The classes replaced hand-written functions; on 124 real windows they must say exactly the same.
test('signals give the same scores and wording as before they were classes', () => {
  const dir = path.join(__dirname, 'fixtures', 'signals');
  const bars = JSON.parse(fs.readFileSync(path.join(dir, 'bars.json'), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
  for (const k of ['emaFast', 'emaSlow', 'rsiPeriod']) assert.equal(policy.strategy[k], expected.policy[k], `fixture was recorded with ${k}=${expected.policy[k]}`);
  for (const c of expected.cases) {
    const w = bars[c.symbol].slice(Math.max(0, c.end - 60), c.end);
    const trend = computeSignals(w, policy);
    assert.deepEqual(trend, c.trend, `${c.symbol} @${c.end} trend`);
    assert.deepEqual(computeMeanReversionSignals(w, policy), c.meanReversion, `${c.symbol} @${c.end} mean reversion`);
    assert.equal(signalTally(trend).composite, c.trendComposite);
  }
  const xs = [...crossSectionalComposite(Object.keys(bars).map(s => ({ symbol: s, bars: bars[s].slice(-60) })))];
  assert.deepEqual(xs, expected.crossSectional);
});

test('a new signal needs only its own arithmetic', () => {
  class GapUp extends Signal {
    id = 'gap-up'; name = 'Gap Up'; family = 'trend'; minBars = 2;
    description = "Today's open against yesterday's high.";
    compute({ bars, last }) { const gap = last.o / bars[bars.length - 2].h - 1; return { score: gap * 50, detail: `gap ${(gap * 100).toFixed(1)}%` }; }
  }
  const s = new GapUp();
  assert.deepEqual(checkSignal(s, policy).failures, []);
  assert.deepEqual(s.score(syntheticBars(1, 3), policy), { name: 'Gap Up', score: 0, detail: 'insufficient data' });
  const big = syntheticBars(5, 4); big[4] = { ...big[4], o: big[3].h * 1.1 };
  assert.equal(s.score(big, policy).score, 1, 'clamped to +1');
});

test('the rules catch a broken signal', () => {
  class Broken extends Signal {
    id = 'Broken Signal'; name = 'Broken'; family = 'trend'; minBars = 0; description = 'x';
    calls = 0;
    compute({ bars }) { bars.pop?.(); this.calls++; return { score: this.calls % 2 ? 0.5 : -0.5, detail: 'flips' }; }
  }
  const failures = checkSignal(new Broken(), policy).failures.join('\n');
  assert.match(failures, /well described/);
  assert.match(failures, /repeatable/);
});

test('a built-in that throws reports a neutral reading instead of breaking the tick', () => {
  class Throws extends Signal {
    id = 'throws'; name = 'Throws'; family = 'trend'; minBars = 0; description = 'Always throws, for the test.';
    compute() { throw new Error('boom'); }
  }
  assert.deepEqual(new Throws().score(syntheticBars(30, 5), policy), { name: 'Throws', score: 0, detail: 'could not score: boom' });
});

test('a model-written signal is a Signal: sandboxed, and silent instead of neutral when it fails', () => {
  const good = new SandboxedSignal('sig-1', 'Last Move', 'function signal(o,h,l,c){ return (c[c.length-1]/c[c.length-2]-1)*20 }', 'One-day move.');
  assert.equal(good.name, 'Learned: Last Move');
  assert.deepEqual(checkSignal(good, policy).failures, []);
  const bad = new SandboxedSignal('sig-2', 'Bad', 'function signal(){ throw new Error("no") }', 'Fails.');
  assert.equal(bad.score(syntheticBars(40, 6), policy), null);
});

test('indicators are computed once per stock and shared by every signal', () => {
  const ctx = new SignalContext(syntheticBars(60, 7), policy);
  assert.equal(ctx.rsi(14), ctx.rsi(14));
  assert.equal(ctx.ema(21), ctx.ema(21));
});

test('promoted learned signals join the trend family and its composite', () => {
  const storage = from('core/storage');
  storage.saveValue('learningLive', { at: '', weights: {}, active: [{ id: 'sig-x', name: 'Always Up', code: 'function signal(){ return 1 }' }] });
  try {
    const trend = computeSignals(syntheticBars(60, 8), policy);
    assert.equal(trend.at(-1).name, 'Learned: Always Up');
    assert.equal(trend.at(-1).score, 1);
    assert.equal(registry.signalsIn('trend', { learned: false }).length, 5);
  } finally { storage.deleteValue('learningLive'); }
});
