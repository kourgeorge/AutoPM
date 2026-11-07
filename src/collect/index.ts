/**
 * L1 — the collection layer.
 *
 * One call gathers every raw input a tick needs, each value stamped with its
 * source, its data timestamp, and whether it is stale. Nothing here derives or
 * interprets: that is L2's job.
 */

import type { AccountInfo, OpenOrder, Position } from '../broker/IBroker';
import type { Bar } from '../core/types';
import type { Timeframe } from './yahoo';
import { collectBars, dailyAnchorDate } from './barSource';
import { collectAccount, collectOpenOrders, collectPositions } from './brokerSource';
import { collectPrices } from './priceSource';
import { DEFAULT_MAX_AGE_MS, isPresent, isUsable, Maybe } from './types';

export * from './types';
export { collectPrice, collectPrices } from './priceSource';
export { collectBars, DEFAULT_MAX_BAR_AGE_MS } from './barSource';
export {
  collectAccount,
  collectOpenOrders,
  collectPositions,
} from './brokerSource';

export interface CollectRequest {
  /** Symbols to collect regardless of whether they are held. */
  watchlist: string[];
  barLimit: number;
  timeframe: Timeframe;
  maxQuoteAgeMs: number;
  maxBarAgeMs?: number;
}

export interface RawBundle {
  collectedAt: string;
  positions: Maybe<Position[]>;
  account: Maybe<AccountInfo>;
  openOrders: Maybe<OpenOrder[]>;
  prices: Map<string, Maybe<number>>;
  bars: Map<string, Maybe<Bar[]>>;
}

export const DEFAULT_COLLECT_REQUEST: Omit<CollectRequest, 'watchlist'> = {
  barLimit: 60,
  timeframe: '1Day',
  maxQuoteAgeMs: DEFAULT_MAX_AGE_MS,
};

/**
 * Daily bars hold completed sessions only, so a symbol's series is the same answer until the
 * next session closes — yet the tick fetched every symbol's 60 bars every minute, day and night.
 * Cached per symbol until the completed session moves on. Only usable series are kept: a
 * failure, or a stale series, is fetched again next tick. The calendar lookup is itself cached
 * for the day, so the check costs no request.
 */
const dailyBars = new Map<string, { anchor: string; bars: Maybe<Bar[]> }>();
export function resetTickBarCache(): void { dailyBars.clear(); }

export async function tickBars(symbol: string, req: CollectRequest): Promise<Maybe<Bar[]>> {
  if (req.timeframe !== '1Day' || req.maxBarAgeMs !== undefined) return collectBars(symbol, req.barLimit, req.timeframe, req.maxBarAgeMs);
  let anchor: string;
  try { anchor = await dailyAnchorDate(symbol, new Date()); }
  catch { return collectBars(symbol, req.barLimit, req.timeframe); }
  const key = `${symbol}:${req.barLimit}`;
  const hit = dailyBars.get(key);
  if (hit && hit.anchor === anchor) return hit.bars;
  const bars = await collectBars(symbol, req.barLimit, req.timeframe);
  if (isUsable(bars)) dailyBars.set(key, { anchor, bars }); else dailyBars.delete(key);
  return bars;
}

/**
 * Collect everything for one tick. Held symbols are always included, even when
 * they have dropped off the watchlist — an open position is never unwatched.
 */
export async function collectAll(req: CollectRequest): Promise<RawBundle> {
  const [positions, account, openOrders] = await Promise.all([
    collectPositions(),
    collectAccount(),
    collectOpenOrders(),
  ]);

  const held = isPresent(positions) ? positions.value.map((p) => p.symbol) : [];
  const symbols = [...new Set([...held, ...req.watchlist])];

  const [prices, barPairs] = await Promise.all([
    collectPrices(symbols, req.maxQuoteAgeMs),
    Promise.all(
      symbols.map(
        async (s) =>
          // `maxBarAgeMs` is passed through UNRESOLVED, undefined included. Defaulting it here
          // used to hand `collectBars` a fixed number every tick, which meant the daily
          // threshold could never be the calendar-derived one — and no caller in the system
          // sets the field, so the constant always won. Undefined is the request to work it out.
          [s, await tickBars(s, req)] as const,
      ),
    ),
  ]);

  return {
    collectedAt: new Date().toISOString(),
    positions,
    account,
    openOrders,
    prices,
    bars: new Map(barPairs),
  };
}
