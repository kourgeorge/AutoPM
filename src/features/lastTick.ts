/**
 * The last computed tick, held for readers who are not the tick itself.
 *
 * `collectAndCompute` builds a full `TickData` every tick (`policy.triggers.tickIntervalMs`) —
 * every non-held watchlist symbol's five signal scores, ATR, RSI, both EMAs, price and
 * staleness — hands it to the detectors, and drops it. `scheduler.ts` says so in as many
 * words, and `daemon.ts` already added the terminal dashboard as a second reader, "which is
 * why the live dashboard costs no broker calls at all".
 *
 * This is the third reader, for the trader. Until it existed the trader learned those same
 * numbers by calling `get_signals(symbol)` once per symbol, each call re-fetching bars over
 * the network to recompute what had been in memory seconds earlier: eighteen rounds of a
 * thirty-round budget spent rebuilding a table that already existed.
 *
 * Read-only by contract, exactly as `onTick` is. This module stores the reference the
 * detectors just judged and transforms nothing — a reader that mutates it is corrupting the
 * evidence behind events that have already been published.
 *
 * **Absent is not empty.** Before the first tick there is no table at all, and `getLastTick`
 * returns null so a caller can say that. An empty watchlist would read as "no candidates",
 * which is a different claim and a false one. Same discipline as `fee: null` in the fills
 * ledger: unknown never renders as zero.
 */

import type { TickData } from './compute';

let _last: TickData | null = null;

/** Record a tick. Called from the `onTick` observer, and by nothing else in production. */
export function recordTick(data: TickData): void {
  _last = data;
}

/**
 * The last tick computed in this process, or null if none has been.
 *
 * Pure and synchronous on purpose: the callers that need it are a tool that must not block
 * on the network and, later, detectors that run inside the tick itself.
 */
export function getLastTick(): TickData | null {
  return _last;
}

/**
 * Test seam. The replay harness resets this per scenario for the same reason it resets the
 * event registry: a tick leaked from the previous scenario makes the suite order-dependent.
 */
export function resetLastTick(): void {
  _last = null;
}
