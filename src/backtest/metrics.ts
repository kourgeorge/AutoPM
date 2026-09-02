/**
 * L1 — the same arithmetic `src/review/metrics.ts`'s `scorecard()` runs over real round trips,
 * adapted to run over `SimulatedTrade[]` from the backtest engine.
 *
 * No fees (the plan's settled cost model is 0.05% slippage baked into fill prices, $0
 * commission), no policy-version grouping (one policy per run, not many over time) — otherwise
 * the same fields, the same caveats-not-verdicts convention, and the same stat helpers.
 */

import type { SimulatedTrade } from './engine';

const perTradeSharpeIsThin = (trades: number) => trades < 20;

function r(n: number | null, dp = 2): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function mean(xs: number[]): number | null {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function meanOverSigma(xs: number[]): number | null {
  const sd = stdev(xs);
  if (sd == null || sd === 0) return null;
  return (xs.reduce((a, b) => a + b, 0) / xs.length) / sd;
}

export interface GroupStats {
  trades: number;
  grossPnL: number;
  winRate: number | null;
  expectancy: number | null;
}

export interface TradeSummary {
  symbol: string;
  exitAt: string;
  grossPnL: number;
  returnPct: number;
  holdingDays: number;
}

export interface Scorecard {
  window: { from: string | null; to: string | null };

  trades: number;
  wins: number;
  losses: number;
  scratches: number;
  winRate: number | null;

  grossPnL: number;

  avgWin: number | null;
  avgLoss: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  expectancyPct: number | null;
  expectancyR: number | null;
  expectancyRSample: number;

  returnPctStdev: number | null;
  perTradeSharpe: number | null;
  perTradeSharpeR: number | null;
  expectancyTStat: number | null;

  best: TradeSummary | null;
  worst: TradeSummary | null;

  avgHoldDays: number | null;
  medianHoldDays: number | null;
  avgHoldWinnersDays: number | null;
  avgHoldLosersDays: number | null;

  /** Deepest peak-to-trough decline of the cumulative REALISED gross P&L, in dollars. */
  maxDrawdown: number;
  maxConsecutiveLosses: number;

  stopDiscipline: {
    breached: number;
    worstBreachPct: number | null;
    avgStopDistancePct: number | null;
    avgStopAtrMultiple: number | null;
  };

  bySymbol: Record<string, GroupStats>;
  byExitReason: Record<string, GroupStats>;

  caveats: string[];
}

function summarise(t: SimulatedTrade): TradeSummary {
  return {
    symbol: t.symbol,
    exitAt: t.exitAt,
    grossPnL: r(t.grossPnL)!,
    returnPct: r(t.returnPct)!,
    holdingDays: t.holdingDays,
  };
}

function groupBy(trades: SimulatedTrade[], key: (t: SimulatedTrade) => string): Record<string, GroupStats> {
  const buckets = new Map<string, SimulatedTrade[]>();
  for (const t of trades) {
    const k = key(t);
    const list = buckets.get(k);
    if (list) list.push(t);
    else buckets.set(k, [t]);
  }

  const out: Record<string, GroupStats> = {};
  for (const [k, list] of [...buckets].sort((a, b) => b[1].length - a[1].length)) {
    const gross = list.reduce((a, t) => a + t.grossPnL, 0);
    out[k] = {
      trades: list.length,
      grossPnL: r(gross)!,
      winRate: r((list.filter(t => t.grossPnL > 0).length / list.length) * 100),
      expectancy: r(gross / list.length),
    };
  }
  return out;
}

export function scorecard(trades: SimulatedTrade[]): Scorecard {
  const empty: Scorecard = {
    window: { from: null, to: null },
    trades: 0, wins: 0, losses: 0, scratches: 0, winRate: null,
    grossPnL: 0,
    avgWin: null, avgLoss: null, profitFactor: null,
    expectancy: null, expectancyPct: null, expectancyR: null, expectancyRSample: 0,
    returnPctStdev: null, perTradeSharpe: null, perTradeSharpeR: null, expectancyTStat: null,
    best: null, worst: null,
    avgHoldDays: null, medianHoldDays: null,
    avgHoldWinnersDays: null, avgHoldLosersDays: null,
    maxDrawdown: 0, maxConsecutiveLosses: 0,
    stopDiscipline: { breached: 0, worstBreachPct: null, avgStopDistancePct: null, avgStopAtrMultiple: null },
    bySymbol: {}, byExitReason: {},
    caveats: ['No simulated trades in this run — nothing here is measurable.'],
  };
  if (trades.length === 0) return empty;

  const wins = trades.filter(t => t.grossPnL > 0);
  const losses = trades.filter(t => t.grossPnL < 0);
  const scratches = trades.length - wins.length - losses.length;

  const grossPnL = trades.reduce((a, t) => a + t.grossPnL, 0);
  const sumWins = wins.reduce((a, t) => a + t.grossPnL, 0);
  const sumLosses = losses.reduce((a, t) => a + t.grossPnL, 0);

  // Realised equity curve in order of exit — same reasoning as `scorecard()`: this is a floor
  // on drawdown, not the true worst, since it ignores the mark-to-market path of open trades.
  let peak = 0, running = 0, maxDrawdown = 0;
  let streak = 0, maxConsecutiveLosses = 0;
  const byExit = [...trades].sort((a, b) => Date.parse(a.exitAt) - Date.parse(b.exitAt));
  for (const t of byExit) {
    running += t.grossPnL;
    peak = Math.max(peak, running);
    maxDrawdown = Math.max(maxDrawdown, peak - running);
    streak = t.grossPnL < 0 ? streak + 1 : 0;
    maxConsecutiveLosses = Math.max(maxConsecutiveLosses, streak);
  }

  const holds = trades.map(t => t.holdingDays);

  const rMultiples: number[] = [];
  const stopDistances: number[] = [];
  const stopAtrMultiples: number[] = [];
  let breached = 0;
  let worstBreachPct: number | null = null;

  for (const t of trades) {
    const stop = t.intendedStop;
    if (!(stop > 0) || !(t.entryPrice > stop)) continue;

    const riskPerShare = t.entryPrice - stop;
    rMultiples.push(t.grossPnL / (riskPerShare * t.qty));
    stopDistances.push((riskPerShare / t.entryPrice) * 100);
    if (t.atrAtEntry > 0) stopAtrMultiples.push(riskPerShare / t.atrAtEntry);

    if (t.exitReason === 'stop' && t.exitPrice < stop) {
      breached++;
      const slip = ((stop - t.exitPrice) / stop) * 100;
      worstBreachPct = worstBreachPct == null ? slip : Math.max(worstBreachPct, slip);
    }
  }

  const returnPcts = trades.map(t => t.returnPct);
  const returnPctStdev = stdev(returnPcts);

  const caveats: string[] = [];
  if (trades.length < 20) {
    caveats.push(`${trades.length} simulated trade(s) — too few for the win rate or expectancy to distinguish skill from variance.`);
  }
  if (rMultiples.length < trades.length) {
    caveats.push(`expectancyR covers ${rMultiples.length} of ${trades.length} trade(s); the rest had no usable stop distance (entry at or below the stop).`);
  }
  const endOfData = trades.filter(t => t.exitReason === 'end_of_data').length;
  if (endOfData > 0) {
    caveats.push(`${endOfData} trade(s) were still open at the end of the data range and were closed at their last known price — not a real exit, included in P&L regardless.`);
  }
  caveats.push('These are trade-shape statistics only, not compared to a benchmark — see the benchmark section of the report for the equity curve against real SPY.');
  if (returnPctStdev != null && perTradeSharpeIsThin(trades.length)) {
    caveats.push(`perTradeSharpe and expectancyTStat are computed over ${trades.length} trade(s) — at this sample size the standard deviation is itself an estimate.`);
  }
  if (returnPctStdev === 0) {
    caveats.push('Every trade returned exactly the same percentage, so the dispersion figures are null rather than infinite.');
  }

  return {
    window: {
      from: trades.reduce((acc, t) => (Date.parse(t.entryAt) <= Date.parse(acc) ? t.entryAt : acc), trades[0].entryAt),
      to: trades.reduce((acc, t) => (Date.parse(t.exitAt) >= Date.parse(acc) ? t.exitAt : acc), trades[0].exitAt),
    },
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    scratches,
    winRate: r((wins.length / trades.length) * 100),

    grossPnL: r(grossPnL)!,

    avgWin: r(mean(wins.map(t => t.grossPnL))),
    avgLoss: r(mean(losses.map(t => t.grossPnL))),
    profitFactor: sumLosses < 0 ? r(sumWins / Math.abs(sumLosses)) : null,
    expectancy: r(grossPnL / trades.length),
    expectancyPct: r(mean(trades.map(t => t.returnPct))),
    expectancyR: r(mean(rMultiples)),
    expectancyRSample: rMultiples.length,

    returnPctStdev: r(returnPctStdev),
    perTradeSharpe: r(meanOverSigma(returnPcts), 3),
    perTradeSharpeR: r(meanOverSigma(rMultiples), 3),
    expectancyTStat: r(
      returnPctStdev != null && returnPctStdev > 0
        ? mean(returnPcts)! / (returnPctStdev / Math.sqrt(returnPcts.length))
        : null,
      2,
    ),

    best: summarise(trades.reduce((a, b) => (b.returnPct > a.returnPct ? b : a))),
    worst: summarise(trades.reduce((a, b) => (b.returnPct < a.returnPct ? b : a))),

    avgHoldDays: r(mean(holds)),
    medianHoldDays: r(median(holds)),
    avgHoldWinnersDays: r(mean(wins.map(t => t.holdingDays))),
    avgHoldLosersDays: r(mean(losses.map(t => t.holdingDays))),

    maxDrawdown: r(maxDrawdown)!,
    maxConsecutiveLosses,

    stopDiscipline: {
      breached,
      worstBreachPct: r(worstBreachPct),
      avgStopDistancePct: r(mean(stopDistances)),
      avgStopAtrMultiple: r(mean(stopAtrMultiples)),
    },

    bySymbol: groupBy(trades, t => t.symbol),
    byExitReason: groupBy(trades, t => t.exitReason),

    caveats,
  };
}
