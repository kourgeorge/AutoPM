/**
 * L1 — the same arithmetic `src/review/metrics.ts`'s `scorecard()` runs over real round trips,
 * adapted to run over `SimulatedTrade[]` from the backtest engine.
 *
 * No fees (the plan's settled cost model is 0.05% slippage baked into fill prices, $0
 * commission), no policy-version grouping (one policy per run, not many over time) — otherwise
 * the same fields, the same caveats-not-verdicts convention, and the same stat helpers.
 */

import type { SimulatedTrade } from './engine';

// One copy of the statistics, shared with the live scorecard so the two cannot drift.
import { perTradeSharpeIsThin, r, groupBy, tradeShape } from '../review/metrics';

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


  const shape = tradeShape(trades, {
    // Backtest: only an exit BY the stop counts as a breach.
    breached: (t, stop) => t.exitReason === 'stop' && t.exitPrice < stop,
    hold: t => t.holdingDays,
    sortByExit: true,
  });
  const returnPctStdev = shape.rawReturnPctStdev;
  const rSample = shape.edge.expectancyRSample;

  const caveats: string[] = [];
  if (trades.length < 20) {
    caveats.push(`${trades.length} simulated trade(s) — too few for the win rate or expectancy to distinguish skill from variance.`);
  }
  if (rSample < trades.length) {
    caveats.push(`expectancyR covers ${rSample} of ${trades.length} trade(s); the rest had no usable stop distance (entry at or below the stop).`);
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
    ...shape.counts,

    ...shape.edge,

    best: summarise(shape.best),
    worst: summarise(shape.worst),

    avgHoldDays: shape.hold.avg,
    medianHoldDays: shape.hold.median,
    avgHoldWinnersDays: shape.hold.winners,
    avgHoldLosersDays: shape.hold.losers,

    ...shape.drawdown,

    stopDiscipline: {
      breached: shape.stops.breached,
      worstBreachPct: shape.stops.worstBreachPct,
      avgStopDistancePct: shape.stops.avgStopDistancePct,
      avgStopAtrMultiple: shape.stops.avgStopAtrMultiple,
    },

    bySymbol: groupBy(trades, t => t.symbol),
    byExitReason: groupBy(trades, t => t.exitReason),

    caveats,
  };
}
