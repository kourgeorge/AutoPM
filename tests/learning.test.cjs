const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-learning-')),
  BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
  ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
});
require(root + '/node_modules/ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access in learning test'); };
require('node:http').request = denyNetwork;
require('node:https').request = denyNetwork;
global.fetch = denyNetwork;
const from = name => require(root + '/src/' + name);
const { compileSignal, checkCode } = from('learning/sandbox');
const evaluate = from('learning/evaluate');
const { signalTally } = from('strategy/signals');
const storage = from('core/storage');
const { SandboxedSignal } = from('signals/sandboxed');
const policy = () => from('policy/load').getPolicy();
const sandboxed = (name, code) => [new SandboxedSignal('sig-' + name, name, code, 'test signal')];

// A seeded random walk per stock, with a known "next week" driver hidden in the volume column.
function rng(seed) { return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }
function market(stocks = 20, days = 1600) {
  const bars = new Map(), r = rng(7);
  const start = Date.UTC(2020, 0, 1);
  for (let s = 0; s < stocks; s++) {
    const series = []; let price = 100;
    // `v` carries a number that tells us next week's drift — the known edge.
    const drift = Array.from({ length: days }, () => (r() - 0.5) * 0.004);
    for (let d = 0; d < days; d++) {
      const futureDrift = drift.slice(d + 1, d + 6).reduce((a, x) => a + x, 0);
      const o = price; price = price * (1 + drift[d] + (r() - 0.5) * 0.002);
      series.push({ t: new Date(start + d * 86_400_000).toISOString(), o, h: Math.max(o, price) * 1.001, l: Math.min(o, price) * 0.999, c: price, v: 1e6 + futureDrift * 1e8 });
    }
    bars.set(s === 0 ? 'SPY' : 'S' + s, series);
  }
  return bars;
}

test('the sandbox refuses ways out of it and stops endless loops', () => {
  for (const bad of ['function signal(){ return process }', 'function signal(){ return require("fs") }',
    'function signal(){ return (function(){}).constructor("return process")() }', 'function signal(){ return globalThis }', 'const x = 1']) {
    assert.throws(() => checkCode(bad), bad);
  }
  const w = { o: [1, 2], h: [1, 2], l: [1, 2], c: [1, 2], v: [1, 1] };
  assert.throws(() => compileSignal('function signal(){ for(;;){} }').run([w], 200), /timed out/);
  assert.deepEqual(compileSignal('function signal(o,h,l,c){ return c[c.length-1] * 10 }').run([w, w]), [1, 1], 'scores are clamped to -1..+1');
  assert.deepEqual(compileSignal('function signal(){ return NaN }').run([w]), [null], 'nonsense numbers become "no score"');
});

test('with nothing learned the composite is the plain average it always was', () => {
  storage.useEphemeralStorage();
  const t = signalTally([{ name: 'EMA Momentum', score: 0.5, detail: '' }, { name: 'MACD', score: -0.1, detail: '' }, { name: 'Volume', score: 0.2, detail: '' }]);
  assert.equal(t.composite, 0.2);
});

test('saved weights change how much each signal counts', () => {
  storage.saveValue('learningWeights', { 'EMA Momentum': 2, MACD: 0 });
  const t = signalTally([{ name: 'EMA Momentum', score: 0.5, detail: '' }, { name: 'MACD', score: -0.9, detail: '' }, { name: 'Volume', score: 0.2, detail: '' }]);
  assert.equal(t.composite, 0.4);  // (2*0.5 + 0*-0.9 + 1*0.2) / 3
  storage.deleteValue('learningWeights');
});

test('a signal that knows next week scores a high IC; noise scores about zero', () => {
  const u = evaluate.buildUniverse(market());
  const knows = evaluate.report(u, evaluate.scoreSignals(u, sandboxed('knows', 'function signal(o,h,l,c,v){ return (v[v.length-1] - 1e6) / 1e6 }'), policy()), 0, '2099-01-01');
  assert.ok(knows.periods.learn.meanIC > 0.5, JSON.stringify(knows.periods.learn));
  assert.ok(knows.periods.learn.tStat > 10);
  // Deterministic "noise": a hash of the last close, unrelated to the future.
  const noise = evaluate.report(u, evaluate.scoreSignals(u, sandboxed('noise', 'function signal(o,h,l,c){ var x = Math.sin(c[c.length-1] * 12345.678) * 1000; return x - Math.floor(x) - 0.5 }'), policy()), 0, '2099-01-01');
  assert.ok(Math.abs(noise.periods.learn.meanIC) < 0.05, JSON.stringify(noise.periods.learn));
  assert.ok(Math.abs(noise.periods.learn.tStat) < 3, JSON.stringify(noise.periods.learn));
  assert.ok(Math.abs(noise.periods.exam.meanIC) < 0.05, JSON.stringify(noise.periods.exam));
});

test('signals only ever see bars up to the day being scored', () => {
  const u = evaluate.buildUniverse(market(12, 400));
  // Returns the window length; a window longer than 60 or reaching past the scored day would show here.
  const sc = evaluate.scoreSignals(u, sandboxed('len', 'function signal(o,h,l,c){ return c.length / 100 }'), policy());
  const seen = new Set(sc.points.flatMap(p => p.scores));
  assert.deepEqual([...seen], [0.6]);
});

test('the bar for new ideas rises with the number tried', () => {
  assert.ok(Math.abs(evaluate.requiredT(1) - 1.96) < 0.02);
  assert.ok(evaluate.requiredT(20) > 2.9 && evaluate.requiredT(20) < 3.1);
  assert.ok(evaluate.requiredT(200) > evaluate.requiredT(20));
});

test('each learning run is kept with before/after weights, drift is capped, and the operator can roll back', async () => {
  storage.useEphemeralStorage();
  const { LEARNING_UNIVERSE } = from('learning/history');
  const loop = from('learning/loop');
  // Saved bars only (refresh: false), so the run never touches the network.
  const dir = path.join(process.env.DATA_DIR, 'learning', 'bars');
  fs.mkdirSync(dir, { recursive: true });
  const bars = [...market(12, 1200).values()];
  LEARNING_UNIVERSE.slice(0, 12).forEach((s, i) => fs.writeFileSync(path.join(dir, s + '.json'), JSON.stringify({ fetchedOn: '2099-01-01', bars: bars[i] })));

  const first = await loop.runLearning({ refresh: false, propose: false, now: new Date('2026-11-09T23:00:00Z') });
  // Move the weights by hand so the second run has something different to start from.
  const moved = Object.fromEntries(Object.keys(first.weights).map(k => [k, 0.6]));
  storage.saveValue('learningLive', { at: 'x', weights: moved, active: [] });
  // Pretend 0.2 was where every weight stood before an earlier run, so 0.6 is already at the cap.
  storage.appendRecord('learning-runs', 'run-old', '2026-11-01T23:00:00Z', { id: 'run-old', type: 'run', at: '2026-11-01T23:00:00Z',
    weightsBefore: Object.fromEntries(Object.keys(first.weights).map(k => [k, 0.2])), weightsAfter: moved, active: [], signals: [], changes: [] });
  const second = await loop.runLearning({ refresh: false, propose: false, now: new Date('2026-11-10T23:00:00Z') });

  const runs = loop.learningRuns().filter(r => r.id !== 'run-old');
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].weightsAfter, first.weights);
  assert.deepEqual(runs[1].weightsBefore, moved);
  assert.deepEqual(runs[1].weightsAfter, second.weights);
  assert.ok(runs[1].signals.length >= Object.keys(first.weights).length);
  for (const s of runs[1].signals) assert.ok(typeof s.reason === 'string' && s.reason.length > 0);
  // No weight may leave 0.2 ± 0.4, and a step up from 0.6 must have been clamped and said so.
  for (const w of Object.values(second.weights)) assert.ok(w <= 0.6 + 1e-9 && w >= -1e-9, String(w));
  assert.ok(second.changes.some(c => /held at 0\.60/.test(c)), second.changes.join('\n'));
  assert.equal(loop.capDrift('X', 1.5, [{ type: 'run', weightsBefore: { X: 1 } }], 1).weight, 1.4);

  const back = loop.rollbackLearning(runs[0].id);
  assert.equal(back.restoredFrom, runs[0].id);
  assert.deepEqual(storage.readValue('learningWeights'), first.weights);
  assert.deepEqual(storage.readValue('learningLive').weights, first.weights);
  assert.throws(() => loop.rollbackLearning('run-nope'), /No learning run/);
});

test('a raise needs the ETFs alone to agree: a signal that works only on the stocks is held, one that works on both may rise', () => {
  const { LEARNING_ETFS } = from('learning/history');
  const loop = from('learning/loop');
  // Same seeded market, but ETF names for the first 11 series. `etfsBackwards` makes the hidden
  // driver point the wrong way on the ETFs, so the signal "works" only on the stock part.
  const build = etfsBackwards => {
    const raw = [...market(26, 1600).values()], bars = new Map();
    raw.forEach((series, i) => {
      const isEtf = i < LEARNING_ETFS.length;
      bars.set(isEtf ? LEARNING_ETFS[i] : 'S' + i, isEtf && etfsBackwards ? series.map(b => ({ ...b, v: 2e6 - b.v })) : series);
    });
    return bars;
  };
  const code = 'function signal(o,h,l,c,v){ return (v[v.length-1] - 1e6) / 1e6 }';
  const measure = bars => {
    const u = evaluate.buildUniverse(bars);
    const etfU = evaluate.buildUniverse(new Map([...bars].filter(([s]) => LEARNING_ETFS.includes(s))));
    const r = evaluate.report(u, evaluate.scoreSignals(u, sandboxed('knows', code), policy()), 0, '9999-12-31');
    r.etfOnly = evaluate.report(etfU, evaluate.scoreSignals(etfU, sandboxed('knows', code), policy()), 0, '9999-12-31').periods;
    return r;
  };

  const stocksOnly = measure(build(true));
  assert.ok(stocksOnly.periods.exam.meanIC > 0 && stocksOnly.etfOnly.exam.meanIC < 0, JSON.stringify([stocksOnly.periods.exam, stocksOnly.etfOnly.exam]));
  const held = loop.builtInStep(stocksOnly, 1);
  assert.equal(held.proposed, 1, 'the weight is held');
  assert.match(held.held, /knows weight held at 1\.00.*ETF-only IC -[\d.]+ does not have the same sign/);

  const both = measure(build(false));
  assert.ok(both.etfOnly.exam.meanIC > 0);
  const up = loop.builtInStep(both, 1);
  assert.equal(up.held, null);
  assert.equal(up.proposed, 1.2);
});
