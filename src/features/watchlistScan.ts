/**
 * The watchlist as one table, taken from the tick that already computed it.
 *
 * Pure and network-free. Every number here was produced by `buildWatchlistData` during the
 * last tick, so this can never become a second opinion on what a signal is — the same reason
 * `signalTally` is exported from `signals.ts` rather than restated per reader. Nothing is
 * recomputed here; the only arithmetic is rounding for display and the age of the tick.
 *
 * Four things this has to say out loud, because each is a way for a table to lie:
 *
 *  - **No tick yet is not an empty watchlist.** `rows: []` with nothing else reads as "no
 *    candidates found". Absent gets its own field and its own caveat.
 *  - **A row the machine declined to score stays in the table.** `computeSignals` returns []
 *    below `strategy.minBars`, and dropping that row would make a symbol with too little
 *    history indistinguishable from one that is not on the watchlist at all.
 *  - **Held names are excluded upstream** — `compute.ts` skips a symbol it holds, because a
 *    held position has its own richer block. So their absence here means "held", not
 *    "unlisted", and they are named rather than silently missing.
 *  - **`stale` on a `WatchlistData` is about the PRICE.** Signals come from bars, which carry
 *    their own freshness, so a row can legitimately have no price and a full set of scores.
 *    Renamed to `priceStale` on the way out for exactly that reason: a bare `stale: true`
 *    sitting beside five scores invites the reading that the scores are stale too.
 *
 * The tick's own age is reported, never judged into a refusal. Per-value staleness already
 * has one owner in `observe()`, and a second opinion on it here is the bug that file exists
 * to prevent. An age past a few tick intervals means the scheduler is not running, which is
 * a fact about the data and therefore a caveat.
 */

import type { TickData } from './compute';
import { signalTally, type SignalTally } from '../strategy/signals';
import type { SignalScore } from '../strategy/signals';
import type { ReversalFilter } from '../strategy/reversal';

/**
 * How many missed tick intervals before the table's age is worth a caveat.
 *
 * Three rather than one: a single interval is ordinary jitter between the tick and a cycle
 * that woke from it, and a caveat on every call is a caveat nobody reads.
 */
const STALE_TICK_MULTIPLE = 3;

export interface ScanRow {
  symbol: string;
  /** Null whenever the quote was missing OR stale — `priceStaleReason` says which. */
  price: number | null;
  priceStale: boolean;
  priceStaleReason: string | null;
  signals: SignalScore[];
  tally: SignalTally;
  summary: string;
  /**
   * The contrarian filter, kept out of `tally.composite` on purpose. Its `score` reads the
   * other way round to a signal score: negative means the name has already run.
   */
  reversal: ReversalFilter;
  atr: number | null;
  rsi: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  emaCrossedUp: boolean | null;
  /** Why the machine declined to score this row, or null if it scored. */
  notScored: string | null;
}

export interface WatchlistScan {
  /** When the tick behind this table was computed. Null when there has been no tick. */
  tickAt: string | null;
  ageMs: number | null;
  rows: ScanRow[];
  /** Watchlist symbols absent from `rows` because the account holds them. */
  heldExcluded: string[];
  /** Facts about the data. Never advice, never a verdict. */
  caveats: string[];
  /** Present only when there is no table to report at all. */
  error?: string;
}

function round(n: number | null, dp: number): number | null {
  return n === null ? null : parseFloat(n.toFixed(dp));
}

/**
 * Project the last tick's watchlist into one table.
 *
 * `now` is a parameter so the replay harness can age a tick without a clock, the same
 * contract `publishTick` follows.
 */
export function watchlistScan(
  tick: TickData | null,
  tickIntervalMs: number,
  now: number = Date.now(),
): WatchlistScan {
  if (tick === null) {
    return {
      tickAt: null,
      ageMs: null,
      rows: [],
      heldExcluded: [],
      caveats: ['No tick has been computed yet, so there is no table. This is not an empty watchlist.'],
      error: 'no tick recorded yet — the scheduler has not completed its first pass in this process',
    };
  }

  const ageMs = now - Date.parse(tick.tickAt);

  const rows: ScanRow[] = Object.values(tick.watchlist).map((w) => {
    const scored = w.signals.length > 0;
    return {
      symbol: w.symbol,
      price: round(w.price, 2),
      priceStale: w.stale,
      priceStaleReason: w.staleReason,
      signals: w.signals.map((s) => ({ ...s, score: round(s.score, 3) as number })),
      tally: signalTally(w.signals),
      summary: w.signalSummary,
      reversal: w.reversal,
      atr: round(w.atr, 2),
      rsi: round(w.rsi, 1),
      emaFast: round(w.emaFast, 2),
      emaSlow: round(w.emaSlow, 2),
      emaCrossedUp: w.emaCrossedUp,
      // `signalSummary` already carries the machine's own words for this ('insufficient
      // data'), so the reason is quoted rather than reinvented one layer down.
      notScored: scored ? null : w.signalSummary,
    };
  });

  // A sort on the composite, not a ranking of quality. It orders on the magnitude the five
  // signals actually produced rather than on how many cleared a dead band, so a name at +0.9
  // no longer sorts level with one at +0.15; `signalTally` owns that mean, so ordering by it
  // introduces no new judgement. Unscored rows (composite null) sort last rather than as zero,
  // because "nobody looked" is not "the signals cancelled out". Symbol is the final tiebreak
  // purely so the same tick always renders in the same order.
  rows.sort(
    (a, b) =>
      (b.tally.composite ?? -Infinity) - (a.tally.composite ?? -Infinity) ||
      a.symbol.localeCompare(b.symbol),
  );

  const caveats: string[] = [];

  if (ageMs > tickIntervalMs * STALE_TICK_MULTIPLE) {
    caveats.push(
      `This table is ${Math.round(ageMs / 1000)}s old against a ${Math.round(tickIntervalMs / 1000)}s tick — the machine should have refreshed it by now, so treat these numbers as last known rather than current.`,
    );
  }

  const notScored = rows.filter((r) => r.notScored !== null).map((r) => r.symbol);
  if (notScored.length > 0) {
    caveats.push(
      `Not scored, and listed with notScored rather than dropped: ${notScored.join(', ')}.`,
    );
  }

  const stalePrices = rows.filter((r) => r.priceStale).map((r) => r.symbol);
  if (stalePrices.length > 0) {
    caveats.push(
      `No usable price this tick: ${stalePrices.join(', ')}. Signals come from bars and may still be present on those rows.`,
    );
  }

  // A fact about what the five numbers ARE, not advice about them. Without it a reader counts
  // five agreeing scores as five confirmations, when every one of them is measuring trend.
  if (rows.some((r) => r.tally.total > 0)) {
    caveats.push(
      'The five signals are one trend family (EMA spread, ADX, breakout, MACD, volume-on-up-day) and are highly correlated, so a 5/5 tally is closer to one confirmation counted five times than to five independent ones. composite is their mean; reversal is the only reading here that can disagree with them.',
    );
  }

  const chasing = rows.filter((r) => r.reversal.chasing).map((r) => r.symbol);
  if (chasing.length > 0) {
    caveats.push(
      `Already up more than their size bucket's chase threshold over the last 21 bars: ${chasing.join(', ')}. Each row's reversal field carries the move and the threshold it cleared.`,
    );
  }

  const unknownSize = rows
    .filter((r) => r.reversal.sizeBucket === 'unknown' && r.reversal.oneMonthReturnPct !== null)
    .map((r) => r.symbol);
  if (unknownSize.length > 0) {
    caveats.push(
      `No cached market cap, so the reversal threshold got no size adjustment: ${unknownSize.join(', ')}. get_fundamentals fills this in for the next tick.`,
    );
  }

  const heldExcluded = Object.keys(tick.positions).sort();
  if (heldExcluded.length > 0) {
    caveats.push(
      `Excluded because they are held, not because they are off the watchlist: ${heldExcluded.join(', ')}. Read those from PORTFOLIO CONTEXT or get_positions.`,
    );
  }

  return { tickAt: tick.tickAt, ageMs, rows, heldExcluded, caveats };
}
