/**
 * L1.5 — the per-day, point-in-time-safe snapshot handed to the AI decision-maker.
 *
 * Same no-lookahead discipline as `engine.ts`'s own day loop: every field here is derived from
 * bars sliced to `<= day t`, never from `Date.now()` or a live call. The caller (`engine.ts`)
 * passes already-sliced windows so that discipline has exactly one place to be enforced, not
 * one per field builder here.
 *
 * Position size is deliberately absent from `OpenPositionDossier` — sizing stays mechanical,
 * so the AI never sees or controls share quantity, only timing and its own stop/take-profit.
 *
 * `signals` carries the same five named, individually-scored `SignalScore[]` the live bot's
 * `get_signals`/`get_watchlist_scan` tools expose (per POLICY.md's SIGNAL EVIDENCE rules) — this
 * used to be reduced away to just `composite`/`signalSummary` before reaching the AI, which gave
 * the backtest AI strictly less resolution than the live bot actually has. Kept alongside the
 * reduced fields rather than replacing them, since the composite/tally line is still a useful
 * quick-glance summary on top of the detail.
 */

import type { Bar } from '../core/types';
import type { Policy } from '../policy/types';
import { atr } from '../strategy/indicators';
import { computeSignals, signalTally, signalSummary, type SignalScore } from '../strategy/signals';

export interface OpenPositionDossier {
  symbol: string;
  entryPrice: number;
  currentPrice: number;
  holdingDays: number;
  unrealizedPnLPct: number;
  currentStop: number;
  currentTakeProfit: number | null;
  signals: SignalScore[];
  signalSummary: string;
  composite: number | null;
}

export interface CandidateDossier {
  symbol: string;
  price: number;
  atr: number;
  signals: SignalScore[];
  signalSummary: string;
  composite: number | null;
}

export interface DailyDossier {
  date: string;
  equity: number;
  cash: number;
  openSlotsRemaining: number;
  dayLossState: 'ok' | 'breached' | 'unmeasurable';
  positions: OpenPositionDossier[];
  candidates: CandidateDossier[];
}

export interface OpenPositionInput {
  symbol: string;
  entryPrice: number;
  entryAt: string;
  stop: number;
  takeProfit: number | null;
  /** Bars sliced to <= day t for this symbol — the caller enforces no-lookahead. */
  windowBars: Bar[];
}

export interface CandidateInput {
  symbol: string;
  /** Bars sliced to <= day t for this symbol — the caller enforces no-lookahead. */
  windowBars: Bar[];
}

export interface BuildDailyDossierParams {
  date: string;
  equity: number;
  cash: number;
  maxPositions: number;
  dayLossState: 'ok' | 'breached' | 'unmeasurable';
  policy: Policy;
  positions: OpenPositionInput[];
  candidates: CandidateInput[];
}

function holdingDaysBetween(entryAt: string, date: string): number {
  return Math.round((Date.parse(date) - Date.parse(entryAt)) / 86_400_000);
}

export function buildDailyDossier(params: BuildDailyDossierParams): DailyDossier {
  const { date, equity, cash, maxPositions, dayLossState, policy, positions, candidates } = params;

  const positionDossiers: OpenPositionDossier[] = positions.map(p => {
    const signals = computeSignals(p.windowBars, policy);
    const { composite } = signalTally(signals);
    const currentPrice = p.windowBars[p.windowBars.length - 1].c;
    return {
      symbol: p.symbol,
      entryPrice: p.entryPrice,
      currentPrice,
      holdingDays: holdingDaysBetween(p.entryAt, date),
      unrealizedPnLPct: ((currentPrice - p.entryPrice) / p.entryPrice) * 100,
      currentStop: p.stop,
      currentTakeProfit: p.takeProfit,
      signals,
      signalSummary: signalSummary(signals),
      composite,
    };
  });

  const candidateDossiers: CandidateDossier[] = [];
  for (const c of candidates) {
    if (c.windowBars.length < policy.strategy.minBars) continue;
    const signals = computeSignals(c.windowBars, policy);
    const { composite } = signalTally(signals);
    const atrSeries = atr(c.windowBars, policy.strategy.atrPeriod);
    if (atrSeries.length === 0) continue;
    candidateDossiers.push({
      symbol: c.symbol,
      price: c.windowBars[c.windowBars.length - 1].c,
      atr: atrSeries[atrSeries.length - 1],
      signals,
      signalSummary: signalSummary(signals),
      composite,
    });
  }

  return {
    date,
    equity,
    cash,
    openSlotsRemaining: Math.max(0, maxPositions - positions.length),
    dayLossState,
    positions: positionDossiers,
    candidates: candidateDossiers,
  };
}
