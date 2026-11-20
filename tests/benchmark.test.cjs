// Pins what the backtest benchmark (src/backtest/benchmarkStats.ts `benchmarkStats`) and the live
// benchmark (src/review/benchmark.ts `benchmark`) return today, before the two are merged.
// Both are fed the same fixed equity and SPY series; every data source is stubbed, nothing reads
// the network, and neither function reads the clock (dates come only from the fixed series).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-benchmark-')),
  BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
  ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
});
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access in benchmark test'); };
require('node:http').request = denyNetwork;
require('node:https').request = denyNetwork;
global.fetch = denyNetwork;
const from = name => require(root + '/src/' + name);
const barCache = from('backtest/barCache');
const barSource = from('collect/barSource');
const { alpacaTrading } = from('core/alpacaHttp');
const { benchmarkStats } = from('backtest/benchmarkStats');
const { benchmark } = from('review/benchmark');

// Equity has every session. SPY is missing 2026-03-05, the day equity shows a 50% crash: if the
// two series were joined by index, or that day were kept, every figure below would move.
const EQUITY = [
  ['2026-03-02', 100000], ['2026-03-03', 101000], ['2026-03-04', 99000], ['2026-03-05', 50000],
  ['2026-03-06', 99500], ['2026-03-09', 102000], ['2026-03-10', 100500], ['2026-03-11', 103000],
];
const SPY = [
  ['2026-03-02', 500], ['2026-03-03', 505], ['2026-03-04', 495],
  ['2026-03-06', 490], ['2026-03-09', 500], ['2026-03-10', 498], ['2026-03-11', 510],
];
// Daily bars are stamped at midnight ET (05:00Z in EST, 04:00Z in EDT from 2026-03-08).
const SPY_BARS = SPY.map(([d, c]) => ({ t: `${d}T${d >= '2026-03-08' ? '04' : '05'}:00:00Z`, o: c, h: c, l: c, c, v: 1000 }));

// Figures shared by both functions, checked by hand over the 7 shared sessions:
//   portfolio 100000 -> 103000 = +3%; SPY 500 -> 510 = +2%; excess 1.
//   portfolio drawdown 101000 -> 99000 = 1.98%; SPY drawdown 505 -> 490 = 2.97%.
//   Sharpe/vol match an independent mean/sample-stdev * sqrt(252) over the 6 daily returns
//   (4.2258 / 30.357 and 3.1093 / 27.828).
const SHARED_FIGURES = {
  portfolioReturnPct: 3,
  spyReturnPct: 2,
  excessPct: 1,
  portfolioSharpe: 4.23,
  spySharpe: 3.11,
  portfolioVolPct: 30.36,
  spyVolPct: 27.83,
  maxDrawdownPct: 1.98,
  spyMaxDrawdownPct: 2.97,
};

async function withStubs(stubs, fn) {
  const saved = {
    getHistoricalBars: barCache.getHistoricalBars,
    collectBars: barSource.collectBars,
    get: alpacaTrading.get,
  };
  if (stubs.historicalBars) barCache.getHistoricalBars = stubs.historicalBars;
  if (stubs.collectBars) barSource.collectBars = stubs.collectBars;
  if (stubs.alpacaGet) alpacaTrading.get = stubs.alpacaGet;
  try { return await fn(); } finally {
    barCache.getHistoricalBars = saved.getHistoricalBars;
    barSource.collectBars = saved.collectBars;
    alpacaTrading.get = saved.get;
  }
}

const equityCurve = () => EQUITY.map(([date, equity]) => ({ date, equity }));

// Alpaca stamps a daily equity point at the session close (16:00 ET).
const portfolioHistory = (rows = EQUITY) => ({
  timestamp: rows.map(([d]) => Date.parse(`${d}T${d >= '2026-03-08' ? '20' : '21'}:00:00Z`) / 1000),
  equity: rows.map(([, v]) => v),
});

function liveStubs({ activities = [] } = {}) {
  const calls = [];
  return {
    calls,
    collectBars: async (symbol, limit, timeframe) => {
      calls.push(['bars', symbol, limit, timeframe]);
      return { value: SPY_BARS, source: 'alpaca', stale: false, error: null };
    },
    alpacaGet: async (url, opts) => {
      calls.push(['get', url, opts?.params]);
      if (url === '/v2/account/portfolio/history') return { data: portfolioHistory() };
      if (url === '/v2/account/activities') return { data: activities };
      throw new Error(`unexpected Alpaca call ${url}`);
    },
  };
}

// ── backtest: benchmarkStats ───────────────────────────────────────────────────

test('benchmarkStats over equity and SPY with a missing SPY day matches the pinned output', async () => {
  const asked = [];
  const out = await withStubs({
    historicalBars: async (symbol, start, end) => { asked.push([symbol, start, end]); return SPY_BARS; },
  }, () => benchmarkStats(equityCurve(), '2026-03-02', '2026-03-11'));

  assert.deepEqual(asked, [['SPY', '2026-03-02', '2026-03-11']]);
  assert.deepEqual(out, {
    window: { from: '2026-03-02', to: '2026-03-11', sessions: 7 },
    ...SHARED_FIGURES,
    caveats: [
      'window is 7 session(s) — too short for a meaningful comparison.',
      'Sharpe figures use a zero risk-free rate on both legs — read them as return per unit of volatility, and compare the simulation to SPY rather than to a textbook threshold.',
      '0.05% slippage and $0 commission are baked into fill prices; no other cost (spread, borrow, tax) is modelled.',
    ],
  });
});

test('benchmarkStats with no SPY bars reports the equity leg alone and no comparison', async () => {
  const out = await withStubs({ historicalBars: async () => [] },
    () => benchmarkStats(equityCurve(), '2026-03-02', '2026-03-11'));

  // Unaligned, so the 2026-03-05 crash day is now part of the equity leg: 101000 -> 50000.
  assert.deepEqual(out, {
    window: { from: '2026-03-02', to: '2026-03-11', sessions: 0 },
    portfolioReturnPct: 3,
    spyReturnPct: null,
    excessPct: null,
    portfolioSharpe: 2.65,  // independent check: 2.6526
    spySharpe: null,
    portfolioVolPct: 706.47, // independent check: 706.47
    spyVolPct: null,
    maxDrawdownPct: 50.5,
    spyMaxDrawdownPct: null,
    caveats: [
      'SPY bars unavailable for this range — no benchmark comparison.',
      'Sharpe figures use a zero risk-free rate on both legs — read them as return per unit of volatility, and compare the simulation to SPY rather than to a textbook threshold.',
      '0.05% slippage and $0 commission are baked into fill prices; no other cost (spread, borrow, tax) is modelled.',
    ],
  });
});

// ── live: benchmark ────────────────────────────────────────────────────────────

test('live benchmark over the same series with a missing SPY day matches the pinned output', async () => {
  const stubs = liveStubs();
  const out = await withStubs(stubs, () => benchmark({ days: 30 }));

  assert.deepEqual(out, {
    window: { from: '2026-03-02', to: '2026-03-11', days: 30, sessions: 7 },
    ...SHARED_FIGURES,
    caveats: [
      'window is 7 session(s) — too short for a meaningful comparison, and one good or bad day moves every figure here',
      'Sharpe figures use a zero risk-free rate on both legs — read them as return per unit of volatility, and compare portfolio to SPY rather than to a textbook threshold',
    ],
  });
  assert.deepEqual(stubs.calls, [
    ['get', '/v2/account/portfolio/history', { period: '30D', timeframe: '1D' }],
    ['bars', 'SPY', 40, '1Day'],
    ['get', '/v2/account/activities', { activity_types: 'CSD,CSW,JNLC', after: '2026-03-02T00:00:00Z', page_size: 100 }],
  ]);
});

test('live benchmark withholds the portfolio figures when a deposit sits inside the window', async () => {
  const deposit = { activity_type: 'CSD', date: '2026-03-06', net_amount: '5000' };
  const out = await withStubs(liveStubs({ activities: [deposit] }), () => benchmark({ days: 30 }));

  assert.deepEqual(out, {
    window: { from: '2026-03-02', to: '2026-03-11', days: 30, sessions: 7 },
    portfolioReturnPct: null,
    spyReturnPct: 2,
    excessPct: null,
    portfolioSharpe: null,
    spySharpe: 3.11,
    portfolioVolPct: null,
    spyVolPct: 27.83,
    maxDrawdownPct: null,
    spyMaxDrawdownPct: 2.97,
    caveats: [
      'window is 7 session(s) — too short for a meaningful comparison, and one good or bad day moves every figure here',
      'Deposits, withdrawals or journals affect this window; adjusted account performance is unavailable.',
    ],
  });
});

test('live benchmark with SPY bars unavailable reports the error and no comparison', async () => {
  const stubs = liveStubs();
  stubs.collectBars = async () => ({ value: null, source: 'alpaca', stale: true, error: 'no data' });
  const out = await withStubs(stubs, () => benchmark({ days: 30 }));

  assert.deepEqual(out, {
    window: { from: '2026-03-02', to: '2026-03-11', days: 30, sessions: 0 },
    portfolioReturnPct: 3,
    spyReturnPct: null,
    excessPct: null,
    portfolioSharpe: 2.65,  // independent check: 2.6526
    spySharpe: null,
    portfolioVolPct: 706.47, // independent check: 706.47
    spyVolPct: null,
    maxDrawdownPct: 50.5,
    spyMaxDrawdownPct: null,
    caveats: [
      'SPY bars unavailable — no data',
      'Sharpe figures use a zero risk-free rate on both legs — read them as return per unit of volatility, and compare portfolio to SPY rather than to a textbook threshold',
    ],
  });
});
