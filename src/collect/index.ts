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
import { collectBars } from './barSource';
import { collectAccount, collectOpenOrders, collectPositions } from './brokerSource';
import { collectPrices } from './priceSource';
import { DEFAULT_MAX_AGE_MS, isPresent, Maybe } from './types';

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
          [s, await collectBars(s, req.barLimit, req.timeframe, req.maxBarAgeMs)] as const,
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
