/**
 * Pull recent executions from the active broker into the durable fills ledger.
 *
 * The one job: make sure that every fill the venue reported inside a window that eventually
 * CLOSES has been copied somewhere that does not close. TWS discards executions at the end
 * of the trading day, so a fill that is never reconciled is not merely unreviewed — it is
 * gone, and every FIFO match after it in that symbol is wrong.
 *
 * Deliberately dumb: fetch an over-wide window, hand it to a ledger that deduplicates, log
 * what was new. There is no cursor to corrupt and no partial state to recover, so the
 * failure mode of a missed run is "the next run picks it up", not "a gap".
 */

import { broker } from '../broker';
import { logger } from '../core/logger';
import { readFills, recordFills } from './fillsLedger';

/**
 * How far back to ask.
 *
 * Wider than any sane reconciliation interval on purpose. Both brokers' time filters are
 * approximate — Alpaca's `after` is documented against activity creation rather than
 * execution, IBKR's needs a timezone this process cannot know — so the boundary is treated
 * as untrustworthy and pushed far enough away that no fill can fall behind it. The cost of
 * overlap is a dedup; the cost of a gap is permanent.
 */
const LOOKBACK_MS = 7 * 24 * 60 * 60_000;

/** Startup reaches back further: the daemon may have been down for days. */
const COLD_LOOKBACK_MS = 30 * 24 * 60 * 60_000;

/**
 * Copy recent fills into the ledger. Returns how many were new.
 *
 * Never throws. A broker that is down, rate-limited or mid-reconnect must not take the
 * scheduler tick with it — the fills are still at the venue and the next run will get them,
 * except in the one case the log has to be explicit about (see `reconcileOnStartup`).
 */
export async function reconcileFills(lookbackMs = LOOKBACK_MS): Promise<number> {
  try {
    const fills = await broker.getFills(new Date(Date.now() - lookbackMs));
    const added = recordFills(fills);
    if (added > 0) {
      logger.info(`[Reconcile] ${added} new fill(s) recorded (${fills.length} returned by broker)`);
    }
    return added;
  } catch (err: any) {
    logger.warn(`[Reconcile] Could not fetch fills: ${err?.message ?? String(err)}`);
    return 0;
  }
}

/**
 * Reconcile at startup, and say plainly whether anything is unrecoverable.
 *
 * The irreducible hole: daemon down for a full session on IBKR, a resting order fills, TWS
 * clears its execution list overnight. Nothing can retrieve that fill. What CAN be done is
 * refuse to let the gap pass as an uneventful stretch — a review that averages over a
 * silently missing exit reports a win rate that was never earned. So the gap between the
 * last recorded fill and now is stated once, at the only moment we know a downtime just
 * ended, and left in the log for the reviewer to find.
 */
export async function reconcileOnStartup(): Promise<void> {
  const before = readFills();
  const last = before[before.length - 1];

  await reconcileFills(COLD_LOOKBACK_MS);

  if (!last) return;

  const after = readFills();
  const gapMs = Date.now() - Date.parse(last.at);
  const recovered = after.length - before.length;

  // One session. Below that the daemon restarted inside a day and the broker's own window
  // still covered everything it missed.
  if (gapMs > 24 * 60 * 60_000) {
    logger.warn(
      `[Reconcile] ${(gapMs / 3_600_000).toFixed(0)}h since the last recorded fill ` +
        `(${last.at}); ${recovered} recovered on startup. Fills executed during a downtime ` +
        `longer than one session may be unrecoverable — treat this window as incomplete.`,
    );
  }
}
