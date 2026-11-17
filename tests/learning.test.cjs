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

test('real closed trades are graded per signal from the scores saved at entry; older entries without them are skipped', () => {
  storage.useEphemeralStorage();
  for (const kind of ['journal', 'fills']) storage.forgetEphemeralRecords(kind);
  const { recordDecision, decision } = from('journal/journal');
  const { recordFills } = from('review/fills');
  const loop = from('learning/loop');
  let n = 0;
  const trade = (symbol, qty, buy, sell, fee, signalsAtEntry, day) => {
    const id = 'ord-' + symbol;
    recordDecision(decision('entry', 'trader', { rationale: 'test', symbol, executed: true, qty, price: buy, brokerOrderId: id, ...(signalsAtEntry ? { signalsAtEntry } : {}) }));
    recordFills([
      { execId: 'x' + n++, brokerOrderId: id, permId: null, symbol, side: 'buy', qty, price: buy, fee, at: `2026-11-0${day}T15:00:00.000Z` },
      { execId: 'x' + n++, brokerOrderId: id + '-exit', permId: null, symbol, side: 'sell', qty, price: sell, fee, at: `2026-11-0${day}T19:00:00.000Z` },
    ]);
  };
  trade('AAA', 10, 100, 110, 1, { EMA: 0.5, MACD: -0.2 }, 2);   // net 98, +9.8%
  trade('BBB', 10, 50, 45, 0, { EMA: -0.4, MACD: 0.3 }, 3);     // net -50, -10%
  trade('CCC', 5, 200, 204, null, { EMA: 0.1, MACD: 0.6 }, 4);  // fees unknown: gross 20, +2%
  trade('DDD', 1, 10, 20, 0, null, 5);                           // an older entry: no scores saved

  const r = loop.realTradeStats();
  assert.equal(r.closedTrades, 4);
  assert.equal(r.withSignals, 3);
  assert.equal(r.skippedNoSignals, 1);
  assert.deepEqual(r.bySignal.EMA, { trades: 3, positive: { trades: 2, avgPnL: 59, avgReturnPct: 5.9 },
    negative: { trades: 1, avgPnL: -50, avgReturnPct: -10 }, rankAgreement: 1 });
  assert.deepEqual(r.bySignal.MACD, { trades: 3, positive: { trades: 2, avgPnL: -15, avgReturnPct: -4 },
    negative: { trades: 1, avgPnL: 98, avgReturnPct: 9.8 }, rankAgreement: -0.5 });

  const card = loop.signalScorecard();
  assert.match(card.howToRead, /fewer than about 20 closed trades these numbers are not evidence/);
  assert.equal(card.realTrades.withSignals, 3);
  for (const kind of ['journal', 'fills']) storage.forgetEphemeralRecords(kind);
});

test('an active learned signal that flips is retired within about 60 days, judged on its recent days since promotion', () => {
  const loop = from('learning/loop');
  // The hidden driver in `v` points the right way until day `flip`, then backwards.
  const flip = 700, days = flip + 80, r = rng(11), series = [];
  const start = Date.UTC(2020, 0, 1);
  for (let s = 0; s < 20; s++) {
    const out = []; let price = 100;
    const drift = Array.from({ length: days }, () => (r() - 0.5) * 0.004);
    for (let d = 0; d < days; d++) {
      const futureDrift = drift.slice(d + 1, d + 6).reduce((a, x) => a + x, 0) * (d < flip ? 1 : -1);
      const o = price; price = price * (1 + drift[d] + (r() - 0.5) * 0.002);
      out.push({ t: new Date(start + d * 86_400_000).toISOString(), o, h: Math.max(o, price) * 1.001, l: Math.min(o, price) * 0.999, c: price, v: 1e6 + futureDrift * 1e8 });
    }
    series.push(out);
  }
  const day = i => series[0][i].t.slice(0, 10);
  const liveSince = day(flip - 160), activeSince = day(flip - 120);   // 40 shadow days, then 120 good active days
  const code = 'function signal(o,h,l,c,v){ return (v[v.length-1] - 1e6) / 1e6 }';
  const at = afterFlip => {
    const bars = new Map(series.map((s, i) => [i === 0 ? 'SPY' : 'S' + i, s.slice(0, flip + afterFlip + 7)]));
    const u = evaluate.buildUniverse(bars), sc = evaluate.scoreSignals(u, sandboxed('flips', code), policy());
    const rep = evaluate.report(u, sc, 0, liveSince);
    const recent = evaluate.recentStats(sc, 0, activeSince, loop.ACTIVE_WINDOW_DAYS);
    return { live: rep.periods.live, recent, next: loop.judgeLearned('active', rep.periods.live, recent, 1) };
  };
  const before = at(0);
  assert.equal(before.next, null, 'still working at the flip: stays active');
  assert.ok(before.recent.meanIC > 0.3, JSON.stringify(before.recent));
  const later = at(60);
  // The old rule (whole period since shadow, non-positive mean) would still keep it.
  assert.ok(later.live.meanIC > 0, JSON.stringify(later.live));
  assert.equal(later.next?.status, 'retired', JSON.stringify(later.recent));
  assert.match(later.next.reason, /last 60 days/);
});

test('a passing shadow signal blocked by three active ones is retired after SHADOW_MAX_DAYS', () => {
  const loop = from('learning/loop');
  const live = days => ({ days, meanIC: 0.04, tStat: 2.5, hitRate: 0.6, spreadPct: 0.3, upMarketIC: 0.04, downMarketIC: 0.04 });
  assert.equal(loop.judgeLearned('shadow', live(loop.SHADOW_MAX_DAYS - 1), null, 3), null, 'waits for a slot');
  assert.equal(loop.judgeLearned('shadow', live(loop.SHADOW_DECIDE_DAYS), null, 2).status, 'active', 'a free slot promotes it');
  assert.equal(loop.judgeLearned('shadow', live(loop.SHADOW_DECIDE_DAYS - 1), null, 2), null, 'not decided before the decision day');
  const out = loop.judgeLearned('shadow', live(loop.SHADOW_MAX_DAYS), null, 3);
  assert.equal(out.status, 'retired');
  assert.match(out.reason, /no active slot/);
});

test('shadow trial false-pass rate: a no-skill signal is rarely promoted, a real one usually is', () => {
  const loop = from('learning/loop');
  const { HORIZON } = evaluate;
  const r = rng(12345);
  const gauss = () => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
  const r3 = x => Math.round(x * 1000) / 1000;
  // One shadow trial: a daily IC = true IC + noise, where the noise is shared by HORIZON days in a
  // row (the five-day returns overlap) with a total spread of 0.1 (about a 100-stock cross-section).
  // Every day it is judged like the loop does, with t corrected for the overlap like evaluate.ts.
  const trial = trueIC => {
    const e = Array.from({ length: loop.SHADOW_MAX_DAYS + HORIZON + 10 }, () => gauss() * 0.1 / Math.sqrt(HORIZON));
    const ics = [];
    for (let d = 0; d < loop.SHADOW_MAX_DAYS + 10; d++) {
      ics.push(trueIC + e.slice(d, d + HORIZON).reduce((a, x) => a + x, 0));
      const n = ics.length, m = ics.reduce((a, x) => a + x, 0) / n;
      const sd = n > 1 ? Math.sqrt(ics.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1)) : 0;
      const live = { days: n, meanIC: r3(m), tStat: sd ? r3(m / (sd / Math.sqrt(n)) / Math.sqrt(HORIZON)) : null,
        hitRate: null, spreadPct: null, upMarketIC: null, downMarketIC: null };
      const next = loop.judgeLearned('shadow', live, null, 0);
      if (next) return next.status;
    }
    return 'shadow';
  };
  const rate = (trueIC, runs) => { let p = 0; for (let k = 0; k < runs; k++) if (trial(trueIC) === 'active') p++; return p / runs; };
  const noSkill = rate(0, 4000), skill = rate(0.05, 1000);
  assert.ok(noSkill <= 0.1, `no-skill promoted ${noSkill}`);
  assert.ok(skill >= 0.6, `real-skill promoted ${skill}`);
});

test('a learned signal is centred with its learning-period median before it enters the composite', () => {
  storage.useEphemeralStorage();
  const { computeSignals } = from('strategy/signals');
  // Ranks well but always scores high: 0.8 + 0.1 x (its rank feature, -1..+1).
  const code = 'function signal(o,h,l,c,v){ return 0.8 + 0.1 * Math.max(-1, Math.min(1, (v[v.length-1] - 1e6) / 1e6)) }';
  const bars = market();
  const u = evaluate.buildUniverse(bars);
  const scale = evaluate.scoreScale(u, evaluate.scoreSignals(u, sandboxed('high', code), policy()), 0);
  assert.ok(Math.abs(scale.median - 0.8) < 0.01 && scale.spread > 0, JSON.stringify(scale));
  // A neutral stock: flat price, so the built-ins put its composite at about 0.
  const window = feature => Array.from({ length: 60 }, (_, i) => ({ t: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString(),
    o: 100, h: 100, l: 100, c: 100, v: i === 59 ? 1e6 + feature * 1e6 : 1e6 }));
  const composite = (feature, active) => {
    storage.saveValue('learningLive', { at: 'x', weights: {}, active });
    storage.saveValue('learningWeights', { 'Learned: high': 2 });
    return signalTally(computeSignals(window(feature), policy())).composite;
  };
  const base = composite(0, []);
  assert.ok(Math.abs(base) < 0.05, `neutral stock composite ${base}`);
  const entry = { id: 'sig-high', name: 'high', code, scale };
  assert.ok(Math.abs(composite(0, [entry]) - base) <= 0.01, 'a neutral stock keeps its composite');
  // Compared with the same stock without it (the volume built-in sees the changed volume too).
  assert.ok(composite(0.5, [entry]) > composite(0.5, []) + 0.05, 'a high rank still lifts the composite');
  assert.ok(composite(-0.5, [entry]) < composite(-0.5, []) - 0.05, 'a low rank still lowers it');
  // An old record with no saved scale and an off-centre median is left out entirely.
  const old = { id: 'sig-old', name: 'high', code };
  assert.equal(composite(0.5, [old]), composite(0.5, []));
  assert.ok(!computeSignals(window(0), policy()).some(s => s.name === 'Learned: high'));
  // One with no saved scale whose median is near 0 counts as it is.
  const centred = { id: 'sig-centred', name: 'high', code: 'function signal(o,h,l,c,v){ return 0.1 * Math.max(-1, Math.min(1, (v[v.length-1] - 1e6) / 1e6)) }' };
  assert.ok(composite(0.5, [centred]) > composite(0.5, []));
  storage.deleteValue('learningLive'); storage.deleteValue('learningWeights');
});
