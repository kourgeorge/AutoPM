/**
 * L2 — feature computation.
 *
 * collectAll() + persisted baselines + indicators -> one TickData.
 *
 * TickData is ephemeral: computed each tick, passed to detectors, then discarded.
 * It is never stored and never served to the LLM — the LLM reads live numbers via
 * get_account and get_positions.
 *
 * Two invariants this file exists to hold:
 *  1. NO NEW MATH. Indicators come from strategy/indicators.ts verbatim; everything
 *     else here is a ratio of two numbers.
 *  2. `sessionHigh` / `sessionLow` are written HERE and nowhere else. Entry baselines
 *     are written only at fill time, and never by this file.
 *
 * All `*Pct` fields are PERCENTAGE POINTS (2.3 means 2.3%), matching the units of
 * `policy.triggers.*Pct`, so a detector can compare a feature to a threshold without
 * a conversion.
 */

import { collectAll, DEFAULT_COLLECT_REQUEST, type RawBundle } from '../collect';
import { isPresent, isUsable, missing, type Maybe } from '../collect/types';
import type { AccountInfo, Position } from '../broker/IBroker';
import type { Bar } from '../core/types';
import { marketSession, type MarketSession } from '../core/time';
import { getPolicy } from '../policy/load';
import type { Policy } from '../policy/types';
import { atr, crossedAbove, ema, rsi } from '../strategy/indicators';
import { computeSignals, signalSummary, type SignalScore } from '../strategy/signals';
import {
  getPositionSnapshot,
  getState,
  patchPositionSnapshot,
  type PositionSnapshot,
} from '../state/state';

// ── Output types ──────────────────────────────────────────────────────────────

export interface PositionData {
  symbol: string;
  qty: number;
  price: number | null;
  /** True when the price feed was stale or missing. */
  stale: boolean;
  staleReason: string | null;
  // Durable baselines from state
  entryPrice: number;
  sessionHigh: number;
  sessionLow: number;
  stopLevel: number | null;
  takeProfitLevel: number | null;
  // Derived ratios — null when an input was stale/missing or bars insufficient
  pnlPct: number | null;
  drawdownFromHighPct: number | null;
  distanceToStopPct: number | null;
  mfePct: number | null;
  maePct: number | null;
  // Indicators
  emaFast: number | null;
  emaSlow: number | null;
  rsi: number | null;
  atr: number | null;
  heldForMs: number;
}

export interface WatchlistData {
  symbol: string;
  price: number | null;
  stale: boolean;
  staleReason: string | null;
  emaFast: number | null;
  emaSlow: number | null;
  /** Fast crossed above slow on the latest bar. Null when series is too short. */
  emaCrossedUp: boolean | null;
  rsi: number | null;
  atr: number | null;
  /** Multi-signal scores for judge-style synthesis by the trader LLM. */
  signals: SignalScore[];
  signalSummary: string;
}

export interface AccountData {
  equity: number | null;
  buyingPower: number | null;
  stale: boolean;
  staleReason: string | null;
  startOfDayEquity: number;
  dayPnLPct: number | null;
  positionCount: number;
}

/** The complete derived state of one tick. Ephemeral — never stored. */
export interface TickData {
  positions: Record<string, PositionData>;
  watchlist: Record<string, WatchlistData>;
  account: AccountData;
  session: MarketSession;
  tickAt: string;
  policyVersion: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Last element of an indicator series, or null. */
function last(series: number[]): number | null {
  return series.length > 0 ? series[series.length - 1] : null;
}

function pct(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(denominator) || denominator === 0) return null;
  return (numerator / denominator) * 100;
}

/** Resolve a Maybe<number> to a plain value + staleness for the detector layer. */
function resolve(m: Maybe<number>): { value: number | null; stale: boolean; reason: string | null } {
  if (isUsable(m)) return { value: m.value, stale: false, reason: null };
  const reason = isPresent(m) ? `stale as of ${m.asOf}` : m.error;
  return { value: null, stale: true, reason };
}

interface Indicators {
  emaFastSeries: number[];
  emaSlowSeries: number[];
  emaFast: number | null;
  emaSlow: number | null;
  rsi: number | null;
  atr: number | null;
}

const NO_INDICATORS: Indicators = {
  emaFastSeries: [],
  emaSlowSeries: [],
  emaFast: null,
  emaSlow: null,
  rsi: null,
  atr: null,
};

/**
 * Run the indicator suite over a bar series.
 *
 * Below `strategy.minBars` nothing is computed: a technically-valid-but-meaningless
 * number seeded off a handful of bars is worse than a null a detector knows to skip.
 */
function indicatorsFor(bars: Maybe<Bar[]>, p: Policy): Indicators {
  if (!isUsable(bars) || bars.value.length < p.strategy.minBars) return NO_INDICATORS;

  const closes = bars.value.map((b) => b.c);
  const emaFastSeries = ema(closes, p.strategy.emaFast);
  const emaSlowSeries = ema(closes, p.strategy.emaSlow);

  return {
    emaFastSeries,
    emaSlowSeries,
    emaFast: last(emaFastSeries),
    emaSlow: last(emaSlowSeries),
    rsi: last(rsi(closes, p.strategy.rsiPeriod)),
    atr: last(atr(bars.value, p.strategy.atrPeriod)),
  };
}

/**
 * Advance the durable session extremes.
 *
 * Monotonic by construction — only ever widen while the position is open.
 */
function baselines(
  pos: Position,
  snap: PositionSnapshot | undefined,
  price: Maybe<number>,
): { entryPrice: number; sessionHigh: number; sessionLow: number } {
  const entryPrice = snap?.entryPrice ?? pos.avgCost;
  let sessionHigh = snap?.sessionHigh ?? entryPrice;
  let sessionLow = snap?.sessionLow ?? entryPrice;

  if (isUsable(price)) {
    sessionHigh = Math.max(sessionHigh, price.value);
    sessionLow = Math.min(sessionLow, price.value);
  }

  if (snap && (sessionHigh !== snap.sessionHigh || sessionLow !== snap.sessionLow)) {
    patchPositionSnapshot(pos.symbol, { sessionHigh, sessionLow });
  }

  return { entryPrice, sessionHigh, sessionLow };
}

// ── Per-subject builders ───────────────────────────────────────────────────────

function buildPositionData(
  pos: Position,
  snap: PositionSnapshot | undefined,
  price: Maybe<number>,
  bars: Maybe<Bar[]>,
  p: Policy,
  computedAt: string,
): PositionData {
  const { entryPrice, sessionHigh, sessionLow } = baselines(pos, snap, price);
  const ind = indicatorsFor(bars, p);
  const { value: spot, stale, reason: staleReason } = resolve(price);

  return {
    symbol: pos.symbol,
    qty: pos.qty,
    price: spot,
    stale,
    staleReason,
    entryPrice,
    sessionHigh,
    sessionLow,
    stopLevel: snap?.stopLevel ?? null,
    takeProfitLevel: snap?.takeProfitLevel ?? null,
    pnlPct: spot === null ? null : pct(spot - entryPrice, entryPrice),
    drawdownFromHighPct: spot === null ? null : pct(sessionHigh - spot, sessionHigh),
    distanceToStopPct:
      spot === null || (snap?.stopLevel ?? null) === null
        ? null
        : pct(spot - snap!.stopLevel!, spot),
    mfePct: pct(sessionHigh - entryPrice, entryPrice),
    maePct: pct(entryPrice - sessionLow, entryPrice),
    emaFast: ind.emaFast,
    emaSlow: ind.emaSlow,
    rsi: ind.rsi,
    atr: ind.atr,
    heldForMs: snap?.openedAt
      ? Math.max(0, Date.parse(computedAt) - Date.parse(snap.openedAt))
      : 0,
  };
}

function buildWatchlistData(
  symbol: string,
  price: Maybe<number>,
  rawBars: Maybe<Bar[]>,
  p: Policy,
): WatchlistData {
  const ind = indicatorsFor(rawBars, p);
  const { value, stale, reason: staleReason } = resolve(price);
  const haveSeries = ind.emaFastSeries.length > 0 && ind.emaSlowSeries.length > 0;

  // Multi-signal scoring for the trader LLM to judge
  const barsArray = isUsable(rawBars) ? rawBars.value : [];
  const signals = barsArray.length >= p.strategy.minBars ? computeSignals(barsArray, p) : [];
  const summary = signals.length > 0 ? signalSummary(signals) : 'insufficient data';

  return {
    symbol,
    price: value,
    stale,
    staleReason,
    emaFast: ind.emaFast,
    emaSlow: ind.emaSlow,
    emaCrossedUp: haveSeries ? crossedAbove(ind.emaFastSeries, ind.emaSlowSeries) : null,
    rsi: ind.rsi,
    atr: ind.atr,
    signals,
    signalSummary: summary,
  };
}

function buildAccountData(
  account: Maybe<AccountInfo>,
  positionCount: number,
  startOfDayEquity: number,
): AccountData {
  if (!isUsable(account)) {
    const reason = isPresent(account) ? `stale as of ${account.asOf}` : account.error;
    return {
      equity: null,
      buyingPower: null,
      stale: true,
      staleReason: reason,
      startOfDayEquity,
      dayPnLPct: null,
      positionCount,
    };
  }

  return {
    equity: account.value.equity,
    buyingPower: account.value.buyingPower,
    stale: false,
    staleReason: null,
    startOfDayEquity,
    dayPnLPct:
      startOfDayEquity > 0
        ? pct(account.value.equity - startOfDayEquity, startOfDayEquity)
        : null,
    positionCount,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Derive one TickData from one already-collected bundle. Pure apart from the
 * `sessionHigh`/`sessionLow` advance — no network, no broker.
 *
 * Separate from `collectAndCompute` so the replay harness can feed a synthetic
 * `RawBundle` through the exact code path the daemon uses.
 */
export function computeTick(raw: RawBundle, p: Policy): TickData {
  const state = getState();
  const computedAt = raw.collectedAt;
  const held = isUsable(raw.positions) ? raw.positions.value : [];
  const heldSymbols = new Set(held.map((pos) => pos.symbol));

  const price = (s: string): Maybe<number> =>
    raw.prices.get(s) ?? missing('derived', `no price collected for ${s}`);
  const bars = (s: string): Maybe<Bar[]> =>
    raw.bars.get(s) ?? missing('derived', `no bars collected for ${s}`);

  const positions: Record<string, PositionData> = {};
  for (const pos of held) {
    positions[pos.symbol] = buildPositionData(
      pos,
      // Through the canonical lookup, not the raw key: a `BTC/USD` snapshot against the
      // venue's `BTCUSD` used to miss here while the cycle context — which normalises —
      // reported the same position as stopped. The stop detector saw no level.
      getPositionSnapshot(pos.symbol),
      price(pos.symbol),
      bars(pos.symbol),
      p,
      computedAt,
    );
  }

  const watchlist: Record<string, WatchlistData> = {};
  for (const symbol of raw.prices.keys()) {
    if (heldSymbols.has(symbol)) continue;
    watchlist[symbol] = buildWatchlistData(symbol, price(symbol), bars(symbol), p);
  }

  return {
    positions,
    watchlist,
    account: buildAccountData(
      raw.account,
      held.length,
      state.startOfDayEquity,
    ),
    tickAt: computedAt,
    session: marketSession(new Date(computedAt)),
    policyVersion: p.version,
  };
}

/**
 * Compute one tick: collect, then derive.
 *
 * Never throws on bad data — a missing feed produces null fields and fires
 * `data_stale`. Throws only if the policy cannot load (no thresholds defined).
 */
export async function collectAndCompute(p: Policy = getPolicy()): Promise<TickData> {
  const raw = await collectAll({
    ...DEFAULT_COLLECT_REQUEST,
    watchlist: [...p.strategy.watchlist],
    maxQuoteAgeMs: p.triggers.maxQuoteAgeMs,
  });
  return computeTick(raw, p);
}
