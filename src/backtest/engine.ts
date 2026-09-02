/**
 * L1 — the walk-forward simulation engine (Level 1: mechanical only, no AI/news/fundamentals/regime).
 *
 * No lookahead, by construction: every decision for "day t" reads bars only through day t's
 * close, and every fill (entry or exit) happens at day t+1's open, slippage-adjusted. This
 * mirrors production's own guard order in `enterPosition` (see `src/strategy/orderManager.ts`)
 * as closely as a backtest can:
 *
 *   entrySignalVeto -> positionSizeVeto -> exposureVeto -> isAtMaxPositions ->
 *   already_holding -> hasEnoughBuyingPower -> dailyLossStatus
 *
 * `earningsVeto` (needs historical fundamentals) and `applyRegimeSizing` (needs live FRED
 * regime data) are skipped for Level 1 — regime "fails open" at a 1.0 size multiplier, which
 * is the same fallback production itself uses when regime data is unavailable, so skipping it
 * entirely is behaviourally equivalent, not a shortcut around a real constraint.
 *
 * The stop-loss LEVEL formula (`entryPrice - stopLossAtrMult * atr`) is a backtest
 * convention, not a copy of an enforced production rule — see the plan doc for why. Only the
 * sizing formula and `canTighten`'s tighten-only mechanics are true reuse of real logic.
 */

import type { AiConfig, Bar } from '../core/types';
import type { Maybe } from '../collect/types';
import type { Policy } from '../policy/types';
import type { ModelProvider } from '../core/modelProvider';
import { atr } from '../strategy/indicators';
import { computeSignals, signalTally } from '../strategy/signals';
import { entrySignalVeto, positionSizeVeto, exposureVeto } from '../strategy/orderManager';
import { dailyLossStatus } from '../strategy/riskManager';
import { canTighten } from '../strategy/stopOrders';
import { getHistoricalBars } from './barCache';
import { buildDailyDossier, type OpenPositionInput, type CandidateInput } from './aiDossier';
import { decideDay, type Decision } from './aiDecision';

export type ExitMode = 'stop_only' | 'stop_trailing' | 'stop_takeprofit';

/**
 * L1.5 — when present, the AI (not `policy.strategy.compositeMin`) decides which candidates to
 * enter and sets its own stop-loss/take-profit, and gets an extra proactive exit channel on top
 * of the existing mechanical stop/take-profit check. Absent, `runBacktest` is exactly the Level 1
 * mechanical engine described above — this is an added branch, not a rewrite.
 */
export interface AiBacktestOptions {
  aiConfig: AiConfig;
  provider: ModelProvider;
}

export interface BacktestConfig {
  policy: Policy;
  exitMode: ExitMode;
  start: string;
  end: string;
  slippagePct: number;
  initialEquity: number;
  /** Only used by `stop_takeprofit` — the target as a multiple of the initial per-share risk. */
  takeProfitRMult: number;
  ai?: AiBacktestOptions;
}

export interface SimulatedTrade {
  symbol: string;
  entryAt: string;
  exitAt: string;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  intendedStop: number;
  atrAtEntry: number;
  grossPnL: number;
  returnPct: number;
  holdingDays: number;
  exitReason: 'stop' | 'take_profit' | 'ai_exit' | 'end_of_data';
}

export interface EquityPoint {
  date: string;
  equity: number;
}

export interface BacktestResult {
  trades: SimulatedTrade[];
  equityCurve: EquityPoint[];
  finalEquity: number;
  caveats: string[];
  /** Present only when `config.ai` was set. */
  aiStats?: { calls: number; cacheHits: number };
  aiDecisionLog?: Array<{ date: string; decisions: Decision[] }>;
}

interface SimPosition {
  symbol: string;
  qty: number;
  entryPrice: number;
  entryAt: string;
  stop: number;
  atrAtEntry: number;
  takeProfit: number | null;
  highSinceEntry: number;
}

const fresh = (bars: Bar[], asOfDate: string): Maybe<Bar[]> => ({
  value: bars,
  source: 'alpaca',
  asOf: `${asOfDate}T00:00:00.000Z`,
  fetchedAt: `${asOfDate}T00:00:00.000Z`,
  stale: false,
});

function dateOf(bar: Bar): string {
  return bar.t.slice(0, 10);
}

/** Requested (pre-guard) size, matching `qty = floor(equity * positionSizePct / price)`. */
function requestedQty(equity: number, price: number, policy: Policy): number {
  return Math.floor((equity * policy.risk.positionSizePct) / price);
}

export async function runBacktest(config: BacktestConfig): Promise<BacktestResult> {
  const { policy, exitMode, start, end, slippagePct, initialEquity, takeProfitRMult, ai } = config;
  const symbols = policy.strategy.watchlist;
  const caveats: string[] = [];

  const barsBySymbol = new Map<string, Bar[]>();
  const dateIndexBySymbol = new Map<string, Map<string, number>>();
  const allDates = new Set<string>();

  for (const symbol of symbols) {
    const bars = await getHistoricalBars(symbol, start, end);
    if (bars.length === 0) {
      caveats.push(`${symbol}: no historical bars returned for this range — excluded entirely.`);
      continue;
    }
    const spanYears = (Date.parse(dateOf(bars[bars.length - 1])) - Date.parse(dateOf(bars[0]))) / (365.25 * 86_400_000);
    if (spanYears < 9) {
      caveats.push(`${symbol}: only ~${spanYears.toFixed(1)} years of bars available (first bar ${dateOf(bars[0])}) — could be a recent listing or a data gap, not distinguished here.`);
    }
    barsBySymbol.set(symbol, bars);
    const idx = new Map<string, number>();
    bars.forEach((b, i) => { idx.set(dateOf(b), i); allDates.add(dateOf(b)); });
    dateIndexBySymbol.set(symbol, idx);
  }

  const calendar = [...allDates].sort();

  const trades: SimulatedTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const open = new Map<string, SimPosition>();
  const lastKnownPrice = new Map<string, number>();
  let cash = initialEquity;
  let startOfDayEquity = initialEquity;
  let aiCalls = 0;
  let aiCacheHits = 0;
  const aiDecisionLog: Array<{ date: string; decisions: Decision[] }> = [];

  function markEquity(closeDate: string): number {
    let value = cash;
    for (const pos of open.values()) {
      const price = lastKnownPrice.get(pos.symbol) ?? pos.entryPrice;
      value += pos.qty * price;
    }
    equityCurve.push({ date: closeDate, equity: value });
    return value;
  }

  for (let i = 0; i < calendar.length - 1; i++) {
    const t = calendar[i];
    const t1 = calendar[i + 1];
    let equityNow = cash;
    for (const pos of open.values()) equityNow += pos.qty * (lastKnownPrice.get(pos.symbol) ?? pos.entryPrice);

    // ── 1. Manage existing positions: decide on day t, fill at day t+1's open ──────────────
    for (const [symbol, pos] of [...open.entries()]) {
      const idxMap = dateIndexBySymbol.get(symbol)!;
      const bars = barsBySymbol.get(symbol)!;
      const tIdx = idxMap.get(t);
      const t1Idx = idxMap.get(t1);
      if (tIdx == null) continue;
      const barT = bars[tIdx];
      lastKnownPrice.set(symbol, barT.c);
      if (t1Idx == null) continue;

      pos.highSinceEntry = Math.max(pos.highSinceEntry, barT.h);

      let nextStop = pos.stop;
      if (exitMode === 'stop_trailing') {
        const window = bars.slice(0, tIdx + 1);
        const atrSeries = atr(window, policy.strategy.atrPeriod);
        const currentAtr = atrSeries.length > 0 ? atrSeries[atrSeries.length - 1] : pos.atrAtEntry;
        const trailingCandidate = pos.highSinceEntry - policy.risk.stopLossAtrMult * currentAtr;
        if (canTighten(pos.stop, trailingCandidate)) nextStop = trailingCandidate;
      }
      pos.stop = nextStop;

      const stopBreached = barT.l <= pos.stop;
      const tpHit = exitMode === 'stop_takeprofit' && pos.takeProfit != null && barT.h >= pos.takeProfit;

      if (stopBreached || tpHit) {
        const fillBar = bars[t1Idx];
        const exitPrice = fillBar.o * (1 - slippagePct);
        const grossPnL = (exitPrice - pos.entryPrice) * pos.qty;
        trades.push({
          symbol,
          entryAt: pos.entryAt,
          exitAt: dateOf(fillBar),
          entryPrice: pos.entryPrice,
          exitPrice,
          qty: pos.qty,
          intendedStop: pos.stop,
          atrAtEntry: pos.atrAtEntry,
          grossPnL,
          returnPct: ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100,
          holdingDays: Math.round((Date.parse(dateOf(fillBar)) - Date.parse(pos.entryAt)) / 86_400_000),
          exitReason: tpHit && !stopBreached ? 'take_profit' : 'stop',
        });
        cash += pos.qty * exitPrice;
        open.delete(symbol);
        lastKnownPrice.set(symbol, exitPrice);
      }
    }

    const dayLoss = dailyLossStatus(equityNow, startOfDayEquity, policy.risk.maxDailyLossPct);

    // ── 1.5. AI decision (L1.5 only): proactive exits, plus the candidate list for entries ──
    let aiDecisionsBySymbol: Map<string, Decision> | null = null;
    if (ai) {
      const positionInputs: OpenPositionInput[] = [];
      for (const pos of open.values()) {
        const idxMap = dateIndexBySymbol.get(pos.symbol)!;
        const bars = barsBySymbol.get(pos.symbol)!;
        const tIdx = idxMap.get(t);
        if (tIdx == null) continue;
        positionInputs.push({
          symbol: pos.symbol,
          entryPrice: pos.entryPrice,
          entryAt: pos.entryAt,
          stop: pos.stop,
          takeProfit: pos.takeProfit,
          windowBars: bars.slice(0, tIdx + 1),
        });
      }

      const candidateInputs: CandidateInput[] = [];
      for (const symbol of symbols) {
        if (open.has(symbol)) continue;
        const idxMap = dateIndexBySymbol.get(symbol);
        const bars = barsBySymbol.get(symbol);
        if (!idxMap || !bars) continue;
        const tIdx = idxMap.get(t);
        const t1Idx = idxMap.get(t1);
        if (tIdx == null || t1Idx == null) continue;
        const window = bars.slice(0, tIdx + 1);
        // Bypass the fixed compositeMin gate — the AI decides entries — but keep the
        // data-sufficiency half of entrySignalVeto ('signals_unavailable').
        const veto = entrySignalVeto(symbol, fresh(window, t), policy, -Infinity);
        if (veto) continue;
        candidateInputs.push({ symbol, windowBars: window });
      }

      const dossier = buildDailyDossier({
        date: t,
        equity: equityNow,
        cash,
        maxPositions: policy.risk.maxPositions,
        dayLossState: dayLoss.state,
        policy,
        positions: positionInputs,
        candidates: candidateInputs,
      });

      const result = await decideDay(dossier, policy, ai.aiConfig, ai.provider);
      aiCalls++;
      if (result.fromCache) aiCacheHits++;
      aiDecisionLog.push({ date: t, decisions: result.decisions });
      aiDecisionsBySymbol = new Map(result.decisions.map(d => [d.symbol, d]));

      // Proactive exits, filled at t+1's open — only for positions that survived section 1's
      // mechanical stop/take-profit check above (that check always wins on the same day).
      for (const decision of result.decisions) {
        if (decision.action !== 'exit') continue;
        const pos = open.get(decision.symbol);
        if (!pos) continue;
        const idxMap = dateIndexBySymbol.get(decision.symbol)!;
        const bars = barsBySymbol.get(decision.symbol)!;
        const t1Idx = idxMap.get(t1);
        if (t1Idx == null) continue;
        const fillBar = bars[t1Idx];
        const exitPrice = fillBar.o * (1 - slippagePct);
        trades.push({
          symbol: decision.symbol,
          entryAt: pos.entryAt,
          exitAt: dateOf(fillBar),
          entryPrice: pos.entryPrice,
          exitPrice,
          qty: pos.qty,
          intendedStop: pos.stop,
          atrAtEntry: pos.atrAtEntry,
          grossPnL: (exitPrice - pos.entryPrice) * pos.qty,
          returnPct: ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100,
          holdingDays: Math.round((Date.parse(dateOf(fillBar)) - Date.parse(pos.entryAt)) / 86_400_000),
          exitReason: 'ai_exit',
        });
        cash += pos.qty * exitPrice;
        open.delete(decision.symbol);
        lastKnownPrice.set(decision.symbol, exitPrice);
      }
    }

    // ── 2. Consider new entries: score every non-held symbol with data on day t ─────────────
    interface Candidate {
      symbol: string;
      composite: number;
      price: number;
      atrVal: number;
      aiStop?: number;
      aiTakeProfit?: number;
    }
    const candidates: Candidate[] = [];
    if (ai) {
      // Only symbols the AI marked 'enter' become candidates — no compositeMin gate here.
      for (const decision of aiDecisionsBySymbol!.values()) {
        if (decision.action !== 'enter' || open.has(decision.symbol)) continue;
        const idxMap = dateIndexBySymbol.get(decision.symbol);
        const bars = barsBySymbol.get(decision.symbol);
        if (!idxMap || !bars) continue;
        const tIdx = idxMap.get(t);
        const t1Idx = idxMap.get(t1);
        if (tIdx == null || t1Idx == null) continue;
        const window = bars.slice(0, tIdx + 1);
        const price = window[window.length - 1].c;
        // Sanity bounds, checked against what the AI actually saw (day t's close): stop must sit
        // strictly between zero and price, and any target must sit above it. A decision that
        // fails this is dropped for the day rather than silently clamped.
        if (decision.stopLoss == null || decision.stopLoss <= 0 || decision.stopLoss >= price) continue;
        if (decision.takeProfit != null && decision.takeProfit <= price) continue;
        const atrSeries = atr(window, policy.strategy.atrPeriod);
        if (atrSeries.length === 0) continue;
        candidates.push({
          symbol: decision.symbol,
          composite: 0,
          price,
          atrVal: atrSeries[atrSeries.length - 1],
          aiStop: decision.stopLoss,
          aiTakeProfit: decision.takeProfit,
        });
      }
    } else {
      for (const symbol of symbols) {
        if (open.has(symbol)) continue;
        const idxMap = dateIndexBySymbol.get(symbol);
        const bars = barsBySymbol.get(symbol);
        if (!idxMap || !bars) continue;
        const tIdx = idxMap.get(t);
        const t1Idx = idxMap.get(t1);
        if (tIdx == null || t1Idx == null) continue;

        const window = bars.slice(0, tIdx + 1);
        const veto = entrySignalVeto(symbol, fresh(window, t), policy, policy.strategy.compositeMin);
        if (veto) continue;

        const { composite } = signalTally(computeSignals(window, policy));
        const atrSeries = atr(window, policy.strategy.atrPeriod);
        if (atrSeries.length === 0) continue;
        candidates.push({
          symbol,
          composite: composite!,
          price: window[window.length - 1].c,
          atrVal: atrSeries[atrSeries.length - 1],
        });
      }
      candidates.sort((a, b) => b.composite - a.composite);
    }

    for (const cand of candidates) {
      if (dayLoss.state !== 'ok') break;
      if (open.size >= policy.risk.maxPositions) break;

      const qty = requestedQty(equityNow, cand.price, policy);
      if (qty <= 0) continue;
      const buyingPower = cash;
      if (buyingPower < qty * cand.price) continue;
      if (positionSizeVeto(qty, cand.price, equityNow, policy)) continue;

      const openPositions = [...open.values()].map(p => ({
        symbol: p.symbol,
        qty: p.qty,
        avgCost: p.entryPrice,
        marketValue: p.qty * (lastKnownPrice.get(p.symbol) ?? p.entryPrice),
      }));
      if (exposureVeto(qty * cand.price, openPositions, equityNow, policy)) continue;

      const idxMap = dateIndexBySymbol.get(cand.symbol)!;
      const bars = barsBySymbol.get(cand.symbol)!;
      const t1Idx = idxMap.get(t1)!;
      const fillBar = bars[t1Idx];
      const entryPrice = fillBar.o * (1 + slippagePct);
      const stop = cand.aiStop != null ? cand.aiStop : cand.price - policy.risk.stopLossAtrMult * cand.atrVal;
      const takeProfit = cand.aiTakeProfit != null
        ? cand.aiTakeProfit
        : (exitMode === 'stop_takeprofit' ? entryPrice + takeProfitRMult * (entryPrice - stop) : null);

      open.set(cand.symbol, {
        symbol: cand.symbol,
        qty,
        entryPrice,
        entryAt: dateOf(fillBar),
        stop,
        atrAtEntry: cand.atrVal,
        takeProfit,
        highSinceEntry: entryPrice,
      });
      cash -= qty * entryPrice;
      lastKnownPrice.set(cand.symbol, entryPrice);
    }

    const equityAtClose = markEquity(t1);
    startOfDayEquity = equityAtClose;
  }

  // Anything still open at the end of the data closes at its last known price.
  for (const [symbol, pos] of open) {
    const exitPrice = lastKnownPrice.get(symbol) ?? pos.entryPrice;
    const lastDate = calendar[calendar.length - 1];
    trades.push({
      symbol,
      entryAt: pos.entryAt,
      exitAt: lastDate,
      entryPrice: pos.entryPrice,
      exitPrice,
      qty: pos.qty,
      intendedStop: pos.stop,
      atrAtEntry: pos.atrAtEntry,
      grossPnL: (exitPrice - pos.entryPrice) * pos.qty,
      returnPct: ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100,
      holdingDays: Math.round((Date.parse(lastDate) - Date.parse(pos.entryAt)) / 86_400_000),
      exitReason: 'end_of_data',
    });
  }
  if (open.size > 0) {
    caveats.push(`${open.size} position(s) still open at the end of the data range were marked closed at their last known price — not a real exit.`);
  }

  return {
    trades,
    equityCurve,
    finalEquity: equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : initialEquity,
    caveats,
    ...(ai ? { aiStats: { calls: aiCalls, cacheHits: aiCacheHits }, aiDecisionLog } : {}),
  };
}
