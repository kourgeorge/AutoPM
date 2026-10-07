const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
Object.assign(process.env, { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-risk-')),
  BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
  ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets' });
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access in risk test'); };
require('http').request = require('https').request = global.fetch = denyNetwork;
const yaml = require('js-yaml');
const loader = require('../src/policy/load');
const { RISK_PROFILES, riskProfileName } = require('../src/policy/riskProfiles');
const { assessEntryRisk, entryLimitPrice } = require('../src/strategy/riskBudget');
const { collectRiskInputs } = require('../src/strategy/riskData');
const { closeStorage } = require('../src/core/storage');
const base = loader.loadPolicy();
after(closeStorage);

function policy(risk = {}) { return { ...base, risk: { ...base.risk, targetVolatilityPct: null, ...risk } }; }
function bars(returns, start = '2026-01-01', price = 100) {
  const out = [{ t: start + 'T05:00:00Z', c: price, o: price, h: price + 1, l: price - 1, v: 100000 }];
  returns.forEach((r, i) => {
    price *= 1 + r;
    out.push({ t: new Date(Date.parse(start + 'T05:00:00Z') + (i + 1) * 86400000).toISOString(), c: price,
      o: price, h: price + 1, l: price - 1, v: 100000 });
  });
  return out;
}
const wave = Array.from({ length: 60 }, (_, i) => i % 2 ? 0.02 : -0.02);
function inputs(histories = {}) {
  return { histories, sectors: { AAPL: 'Technology', MSFT: 'Technology', HEDGE: 'Other' }, errors: {},
    asOf: Object.values(histories)[0]?.at(-1).t.slice(0, 10) ?? null };
}
function assess(overrides = {}) {
  return assessEntryRisk({ symbol: 'AAPL', price: 100, stopLoss: 95, takeProfit: 115,
    equity: 100000, buyingPower: 100000, positions: [], policy: policy(), inputs: inputs(), ...overrides });
}

test('legacy policy keeps the new preferences unconfigured; invalid values fail validation', () => {
  const old = structuredClone(base);
  for (const key of ['riskPerTradePct', 'targetVolatilityPct', 'minRewardRisk']) delete old.risk[key];
  const parsed = loader.parsePolicy(yaml.dump(old));
  assert.equal(parsed.ok, true);
  for (const key of ['riskPerTradePct', 'targetVolatilityPct', 'minRewardRisk']) assert.equal(parsed.policy.risk[key], null);
  for (const [key, values] of Object.entries({ riskPerTradePct: [-1, 0, 2.01, '0.5'], targetVolatilityPct: [0, 51, Infinity], minRewardRisk: [0, 21, NaN] })) {
    for (const value of values) {
      const invalid = structuredClone(base); invalid.risk[key] = value;
      assert.equal(loader.parsePolicy(yaml.dump(invalid)).ok, false, `${key}: ${value}`);
    }
  }
});

test('presets are explicit policy values and saved revisions retain their risk constraints', () => {
  for (const [name, values] of Object.entries(RISK_PROFILES)) {
    const before = loader.getPolicySnapshot();
    const saved = loader.saveStrategy({ ...before.policy, risk: { ...before.policy.risk, ...values } }, before.hash, 'test-admin');
    assert.equal(saved.riskProfile, name);
    assert.notEqual(saved.hash, before.hash);
    assert.equal(loader.reloadPolicy().ok, true);
    assert.equal(riskProfileName(loader.getPolicy().risk), name);
  }
  const before = loader.getPolicySnapshot();
  const saved = loader.saveStrategy({ ...before.policy, risk: { ...before.policy.risk, riskPerTradePct: 0.7 } }, before.hash, 'test-admin');
  assert.equal(saved.riskProfile, 'custom');
  assert.throws(() => loader.saveStrategy(before.policy, before.hash, 'test-admin'), /changed/);
  loader.useEphemeralPolicy(base);
});

test('wider stops buy fewer shares for the same planned loss; capital remains a separate cap', () => {
  const normal = assess(), wide = assess({ stopLoss: 90, takeProfit: 125 });
  assert.equal(normal.maxQty, 100); assert.equal(wide.maxQty, 50);
  assert.equal(normal.plannedLoss, 500); assert.equal(wide.plannedLoss, 500);
  const narrow = assess({ stopLoss: 99 });
  assert.equal(narrow.maxQty, 100); assert.equal(narrow.plannedLoss, 100);
  assert.equal(assess({ policy: policy({ riskPerTradePct: 0.25 }) }).maxQty, 50);
  assert.equal(assess({ qty: 101 }).allowed, false);
});

test('reward:risk is checked at the executable limit, not the optimistic quoted entry', () => {
  assert.equal(assess({ takeProfit: 110 }).allowed, true);
  const atLimit = assess({ price: entryLimitPrice(100, 100), takeProfit: 110 });
  assert.equal(atLimit.allowed, false);
  assert.equal(atLimit.violations[0].rule, 'reward_risk_too_low');
  assert.equal(atLimit.maxQty, 0);
  assert.ok(atLimit.rewardRisk < 2);
});

test('portfolio volatility sizes volatile assets down and never fills a fractional share', () => {
  const high = inputs({ AAPL: bars(wave.map(r => r * 5)) });
  const low = inputs({ AAPL: bars(wave.map(r => r / 10)) });
  const constrained = policy({ targetVolatilityPct: 8 });
  const highPlan = assess({ policy: constrained, inputs: high });
  const lowPlan = assess({ policy: constrained, inputs: low });
  assert.ok(highPlan.maxQty < lowPlan.maxQty);
  assert.ok(highPlan.volatilityAfterPct <= 8);
  assert.ok(assess({ policy: constrained, inputs: high, qty: highPlan.maxQty + 1 }).violations.some(v => v.rule === 'portfolio_volatility'));
  assert.equal(assess({ equity: 100, buyingPower: 100 }).maxQty, 0);
});

test('covariance distinguishes diversification from another correlated holding', () => {
  const held = [{ symbol: 'MSFT', qty: 200, avgCost: 100, marketValue: 20000 }];
  const p = policy({ targetVolatilityPct: 8, maxSectorWeightPct: 100 });
  const same = assess({ policy: p, positions: held, inputs: inputs({ MSFT: bars(wave), AAPL: bars(wave) }) });
  const opposite = assess({ policy: p, positions: held, inputs: inputs({ MSFT: bars(wave), AAPL: bars(wave.map(r => -r)) }) });
  assert.ok(same.maxQty < opposite.maxQty);
  assert.ok(opposite.volatilityAfterPct < opposite.volatilityBeforePct);
});

test('an already over-target portfolio requires the actual hedge size, including smaller approvals', () => {
  const positions = [{ symbol: 'MSFT', qty: 400, avgCost: 100, marketValue: 40000 }];
  const p = policy({ targetVolatilityPct: 10, maxSectorWeightPct: 100 });
  const data = inputs({ MSFT: bars(wave), AAPL: bars(wave.map(r => -r)) });
  const plan = assess({ positions, policy: p, inputs: data });
  assert.equal(plan.allowed, true);
  assert.ok(plan.volatilityBeforePct > 10); assert.ok(plan.volatilityAfterPct < 10);
  const tooSmall = assess({ positions, policy: p, inputs: data, qty: 1 });
  assert.equal(tooSmall.allowed, false);
  assert.ok(tooSmall.violations.some(v => v.rule === 'portfolio_volatility'));
});

test('missing, stale, short, invalid and misaligned return histories cannot pass a volatility target', () => {
  const p = policy({ targetVolatilityPct: 12 });
  const good = bars(wave);
  const cases = [inputs(), inputs({ AAPL: good.slice(-30) }), { ...inputs({ AAPL: good }), errors: { AAPL: 'stale' } },
    { ...inputs({ AAPL: good }), histories: { AAPL: good.slice(0, -1) } },
    inputs({ AAPL: [...good, good.at(-1)] }),
    inputs({ AAPL: good.map((b, i) => i === 4 ? { ...b, c: 0 } : b) }),
    inputs({ AAPL: good.map((b, i) => i === 4 ? { ...b, c: 1e-310 } : b) }),
    { ...inputs({ AAPL: good }), histories: { AAPL: good.map((b, i) => i === 4 ? { ...b, t: 'invalid' } : b) } },
  ];
  for (const data of cases) {
    const plan = assess({ policy: p, inputs: data });
    assert.equal(plan.allowed, false); assert.equal(plan.maxQty, 0);
    assert.ok(plan.violations.some(v => v.rule === 'risk_data_unavailable'));
  }
  const shifted = bars(wave, '2026-03-01');
  const data = inputs({ AAPL: shifted, MSFT: good });
  assert.equal(assess({ policy: p, inputs: data, positions: [{ symbol: 'MSFT', qty: 1, marketValue: 100 }] }).allowed, false);
});

test('history after the decision session is excluded, and flat returns are valid zero volatility', () => {
  const history = bars(Array(60).fill(0));
  const data = inputs({ AAPL: history });
  const before = assess({ policy: policy({ targetVolatilityPct: 1 }), inputs: data });
  data.histories.AAPL = [...history, { ...history.at(-1), t: '2027-01-01T05:00:00Z', c: 99999 }];
  const after = assess({ policy: policy({ targetVolatilityPct: 1 }), inputs: data });
  assert.equal(before.volatilityAfterPct, 0); assert.equal(after.maxQty, before.maxQty);
  assert.equal(after.volatilityAfterPct, 0);
});

test('single-name, sector, gross exposure, cash and unknown classifications all constrain sizing', () => {
  const pos = { symbol: 'MSFT', qty: 295, marketValue: 29500 };
  assert.equal(assess({ positions: [pos] }).maxQty, 5);
  assert.equal(assess({ positions: [pos], inputs: { ...inputs(), sectors: {} } }).maxQty, 5);
  assert.equal(assess({ policy: policy({ maxSingleWeightPct: 2 }) }).maxQty, 20);
  assert.equal(assess({ buyingPower: 99 }).maxQty, 0);
  assert.equal(assess({ policy: policy({ maxGrossExposurePct: 0.3 }), positions: [pos] }).maxQty, 5);
  assert.equal(assess({ positions: [{ ...pos, marketValue: undefined }] }).violations[0].rule, 'risk_data_unavailable');
});

test('risk data is cached by completed session; stale failures recover without pinning a bad observation', async () => {
  const source = require('../src/collect/barSource'), calendar = require('../src/collect/marketCalendar');
  const sectors = require('../src/collect/sectorCache');
  const originalBars = source.collectBars, originalSession = calendar.lastCompletedSession, originalSectors = sectors.getSectors;
  let calls = 0, stale = true, session = '2026-03-02';
  const history = bars(wave);
  try {
    calendar.lastCompletedSession = async () => ({ date: session, close: '16:00' });
    sectors.getSectors = async () => ({ CACHE: 'Technology' });
    source.collectBars = async () => { calls++; return { value: history, stale, asOf: history.at(-1).t }; };
    const first = await collectRiskInputs(['CACHE'], base);
    assert.match(first.errors.CACHE, /Fresh daily/);
    stale = false;
    assert.ok((await collectRiskInputs(['CACHE'], base)).histories.CACHE);
    await collectRiskInputs(['CACHE'], base); assert.equal(calls, 2);
    session = '2026-03-03';
    assert.match((await collectRiskInputs(['CACHE'], base)).errors.CACHE, /does not reach/);
    assert.equal(calls, 3);
  } finally { source.collectBars = originalBars; calendar.lastCompletedSession = originalSession; sectors.getSectors = originalSectors; }
});

test('watchlist ranking prefers the candidate that fits the current portfolio', async () => {
  const { riskAwareWatchlistScan } = require('../src/strategy/entryPlanning');
  const { recordTick } = require('../src/features/lastTick');
  const riskData = require('../src/strategy/riskData'), { broker } = require('../src/broker');
  const original = riskData.collectRiskInputs;
  const p = policy({ targetVolatilityPct: 5, maxSectorWeightPct: 100 });
  const row = symbol => ({ symbol, price: 100, stale: false, staleReason: null, atr: 2, rsi: 60,
    emaFast: 101, emaSlow: 99, emaCrossedUp: false, signals: [{ name: 'trend', score: 0.6 }], signalSummary: 'trend',
    meanReversionSignals: [], meanReversionSummary: 'none', reversal: { chasing: false, sizeBucket: 'large', oneMonthReturnPct: 1 } });
  try {
    loader.useEphemeralPolicy(p);
    broker.getAccountInfo = async () => ({ equity: 100000, cash: 60000, buyingPower: 60000 });
    broker.getPositions = async () => [{ symbol: 'MSFT', qty: 150, marketValue: 15000 }];
    riskData.collectRiskInputs = async () => inputs({ MSFT: bars(wave), AAPL: bars(wave), HEDGE: bars(wave.map(r => -r)) });
    recordTick({ tickAt: new Date().toISOString(), positions: {}, watchlist: { AAPL: row('AAPL'), HEDGE: row('HEDGE') } });
    const scan = await riskAwareWatchlistScan();
    assert.equal(scan.rows[0].symbol, 'HEDGE');
    assert.ok(scan.rows[0].riskAdjustedScore > scan.rows[1].riskAdjustedScore);
    riskData.collectRiskInputs = async () => { throw new Error('portfolio feed unavailable'); };
    const failed = await riskAwareWatchlistScan();
    assert.match(failed.riskError, /unavailable/);
    assert.ok(failed.rows.every(row => row.riskFit === null && row.riskAdjustedScore === null));
  } finally { riskData.collectRiskInputs = original; loader.useEphemeralPolicy(base); }
});

test('historical simulation shares risk sizing and discloses unsupported targetless reward:risk', async () => {
  const source = require('../src/backtest/barCache');
  const original = source.getHistoricalBars;
  const history = bars(Array.from({ length: 100 }, (_, i) => i % 2 ? 0.0005 : -0.0003));
  const { runBacktest } = require('../src/backtest/engine');
  try {
    source.getHistoricalBars = async () => history;
    const p = policy({ riskPerTradePct: 0.1, targetVolatilityPct: 12 });
    p.strategy = { ...p.strategy, watchlist: ['AAPL'], compositeMin: -1 };
    const config = { policy: p, exitMode: 'stop_only', start: '2026-01-01', end: '2026-04-30',
      slippagePct: 0, initialEquity: 100000, takeProfitRMult: 2 };
    const result = await runBacktest(config);
    assert.ok(result.trades.length > 0);
    assert.ok(result.trades.every(t => t.qty <= 25), 'a $100 planned loss budget sizes a $4 stop to at most 25 shares');
    assert.ok(result.caveats.some(c => /do not validate that threshold/.test(c)));
    const targetResult = await runBacktest({ ...config, exitMode: 'stop_takeprofit' });
    assert.ok(targetResult.trades.length > 0);
    assert.ok(!targetResult.caveats.some(c => /do not validate that threshold/.test(c)));
  } finally { source.getHistoricalBars = original; }
});

test('live planning and execution enforce the same risk constraints and record the action assessment', async () => {
  const orders = require('../src/strategy/orderManager'), riskData = require('../src/strategy/riskData');
  const prices = require('../src/collect/priceSource'), source = require('../src/collect/barSource');
  const fundamentals = require('../src/collect/fundamentals'), regime = require('../src/macro/regime');
  const { broker } = require('../src/broker'), state = require('../src/state/state');
  const { entryPlan } = require('../src/strategy/entryPlanning');
  const originals = [prices.collectPrices, source.collectBars, fundamentals.getFundamentals, regime.getRegime, riskData.collectRiskInputs];
  const p = policy({ targetVolatilityPct: 12, earningsBlackoutDays: 0 });
  const history = bars(wave.map(r => r / 5));
  const signal = { symbol: 'AAPL', signal: 'buy', price: 100, stopLoss: 95, takeProfit: 115, atr: 2, reason: 'Supported test setup' };
  try {
    loader.useEphemeralPolicy(p);
    state.updateState({ paused: false, dailyLossHalted: false, startOfDayEquity: 100000, accountId: 'alpaca:paper:test', positionSnapshots: {} });
    broker.isMarketOpen = async () => true;
    broker.getAccountInfo = async () => ({ equity: 100000, buyingPower: 100000, cash: 100000 });
    broker.getPositions = async () => [];
    broker.getOpenOrders = async () => [];
    prices.collectPrices = async () => new Map([['AAPL', { value: 100, stale: false }]]);
    // Strong trend for the independent signal gate; risk uses daily return history below.
    source.collectBars = async () => ({ value: Array.from({ length: 200 }, (_, i) => ({ t: history.at(-1).t, o: 20 + i * .4, h: 21 + i * .4, l: 19 + i * .4, c: 20.5 + i * .4, v: 100000 + i * 1000 })), stale: false });
    fundamentals.getFundamentals = async () => ({ calendar: { nextEarningsAt: null, daysUntil: null } });
    regime.getRegime = async () => ({ regime: 'expansion', confidence: 'high' });
    riskData.collectRiskInputs = async () => inputs({ AAPL: history });
    const plan = await entryPlan(signal);
    assert.equal(plan.allowed, true); assert.equal(plan.maxQty, 96);
    const validated = await orders.validateEntry(signal, plan.maxQty);
    assert.equal(validated.riskAssessment.allowed, true);
    assert.equal(validated.riskAssessment.plannedLoss, plan.plannedLoss);
    await assert.rejects(() => orders.validateEntry(signal, plan.maxQty + 1), e => e.rule === 'risk_per_trade');
    await assert.rejects(() => orders.validateEntry({ ...signal, takeProfit: 110 }, 1), e => e.rule === 'reward_risk_too_low');
    const queued = await orders.enterPosition(signal, plan.maxQty);
    assert.equal(require('../src/core/actions').getAction(queued.actionId).params.riskAssessment.plannedLoss, plan.plannedLoss);
    const held = [{ symbol: 'MSFT', qty: 400, marketValue: 40000 }];
    broker.getPositions = async () => held;
    loader.useEphemeralPolicy(policy({ riskPerTradePct: 1, targetVolatilityPct: 10, maxSectorWeightPct: 100, earningsBlackoutDays: 0 }));
    riskData.collectRiskInputs = async () => inputs({ MSFT: bars(wave), AAPL: bars(wave.map(r => -r)) });
    assert.equal((await orders.validateEntry(signal, 99)).riskAssessment.allowed, true);
    await assert.rejects(() => orders.validateEntry(signal, 99, 1), e => e.rule === 'portfolio_volatility');
    riskData.collectRiskInputs = async () => inputs();
    await assert.rejects(() => orders.validateEntry(signal, 1), e => e.rule === 'risk_data_unavailable');
  } finally {
    [prices.collectPrices, source.collectBars, fundamentals.getFundamentals, regime.getRegime, riskData.collectRiskInputs] = originals;
    loader.useEphemeralPolicy(base);
  }
});
