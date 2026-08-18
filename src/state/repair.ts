/**
 * Startup repair of the durable session extremes.
 *
 * `sessionHigh` / `sessionLow` are monotonic by construction — `baselines()` in
 * `features/compute.ts` only ever widens them, and it is their only writer. That is the
 * right shape for MFE/MAE, which must describe the whole life of a position rather than
 * the last tick, but it means the state has NO PATH BACK. One bad price is permanent for
 * as long as the position is held.
 *
 * Which duly happened: a one-sided after-hours book put half of TSLA's real price into
 * `sessionLow` (see `quoteCandidate` in `collect/priceSource.ts`, now fixed at the source),
 * and the resulting "MAE -52.2%" was re-litigated by the model in three consecutive cycles.
 * Fixing the source stops new corruption; it cannot touch what is already on disk.
 *
 * The repair narrows, never widens, and it only ever replaces a stored figure with one
 * MEASURED from bars — never an average, never an estimate, never `entryPrice` standing in
 * for a price nobody printed (§ "never guess a datum"). A position whose bars cannot be
 * fetched is left exactly as it was and said so out loud, because a silent skip here reads
 * identically to a clean bill of health.
 */

import { collectBars } from '../collect';
import { isPresent } from '../collect/types';
import { logger } from '../core/logger';
import { getState, patchPositionSnapshot, type PositionSnapshot } from './state';

/** Daily bars to fetch per symbol. Comfortably covers any holding period this system opens. */
const BAR_LIMIT = 90;

/**
 * How far outside the bar range a stored figure must sit before it is treated as wrong.
 *
 * Required for correctness, not convenience: the stored extremes come from Alpaca/IEX
 * ticks while the bars come from Yahoo, and two feeds disagreeing by cents on a daily
 * high is normal — odd lots and extended-hours prints fall outside a consolidated daily
 * bar routinely. This is here to catch a figure that is wrong by half, not to police
 * pennies between sources.
 */
const TOLERANCE = 0.01;

interface Range { low: number; high: number }

/**
 * The first bar date to consider: the day BEFORE the position opened.
 *
 * Compared as a date, not an instant, and deliberately one session early. A daily bar is
 * stamped at the open — measured: `2026-08-13T13:30:00.000Z` — so an instant comparison
 * against an intraday `openedAt` drops the very day the position was bought, which is
 * usually its most volatile. That is not a cosmetic error: on the first run of this repair
 * SPCX (opened 08-12T17:23Z, spiked +8.5% that day) had the 08-12 bar excluded and its
 * perfectly good high of 148.86 pulled down to the following day's 145.05 — the repair
 * damaging exactly the kind of value it exists to protect.
 *
 * Starting a day early also absorbs any ET/UTC boundary question for a fill logged in the
 * evening. A window that is one session too WIDE can only produce a looser bound, i.e.
 * fewer corrections; one that is too narrow invents them.
 */
function windowStart(openedAt: string): string {
  const d = new Date(`${openedAt.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The lowest and highest price the position can be shown to have traded at.
 *
 * `entryPrice` is folded in because a fill IS a print: the position demonstrably traded
 * there, whatever the bars from another vendor happen to say.
 */
function observedRange(bars: { t: string; h: number; l: number }[], snap: PositionSnapshot): Range | null {
  // An unknown open date widens the window to everything fetched rather than narrowing it.
  // A looser bound makes FEWER corrections; a guessed one would make wrong corrections.
  const from = snap.openedAt ? windowStart(snap.openedAt) : '';
  const relevant = from === '' ? bars : bars.filter(b => b.t.slice(0, 10) >= from);
  const usable = (relevant.length > 0 ? relevant : bars).filter(
    b => Number.isFinite(b.l) && Number.isFinite(b.h) && b.l > 0,
  );
  if (usable.length === 0) return null;

  let low = Math.min(...usable.map(b => b.l));
  let high = Math.max(...usable.map(b => b.h));
  if (snap.entryPrice != null && snap.entryPrice > 0) {
    low = Math.min(low, snap.entryPrice);
    high = Math.max(high, snap.entryPrice);
  }
  return { low, high };
}

export async function repairSessionExtremes(): Promise<void> {
  const snapshots = Object.values(getState().positionSnapshots).filter(
    s => s.sessionHigh != null || s.sessionLow != null,
  );
  if (snapshots.length === 0) return;

  const results = await Promise.all(
    snapshots.map(async snap => ({
      snap,
      bars: await collectBars(snap.symbol, BAR_LIMIT, '1Day'),
    })),
  );

  let repaired = 0;
  for (const { snap, bars } of results) {
    if (!isPresent(bars)) {
      logger.warn(
        `[Repair] ${snap.symbol}: bars unavailable (${bars.error}) — session extremes left as ` +
          `recorded (high ${snap.sessionHigh ?? 'none'}, low ${snap.sessionLow ?? 'none'}), unverified.`,
      );
      continue;
    }

    const range = observedRange(bars.value, snap);
    if (!range) {
      logger.warn(`[Repair] ${snap.symbol}: no usable bars — session extremes left unverified.`);
      continue;
    }

    const patch: { sessionHigh?: number; sessionLow?: number } = {};
    if (snap.sessionLow != null && snap.sessionLow < range.low * (1 - TOLERANCE)) {
      patch.sessionLow = range.low;
    }
    if (snap.sessionHigh != null && snap.sessionHigh > range.high * (1 + TOLERANCE)) {
      patch.sessionHigh = range.high;
    }
    if (Object.keys(patch).length === 0) continue;

    patchPositionSnapshot(snap.symbol, patch);
    repaired++;
    logger.warn(
      `[Repair] ${snap.symbol}: a recorded extreme lies outside the traded range ` +
        `[${range.low.toFixed(2)}, ${range.high.toFixed(2)}] and cannot have happened. ` +
        (patch.sessionLow != null ? `low ${snap.sessionLow} -> ${patch.sessionLow.toFixed(2)}. ` : '') +
        (patch.sessionHigh != null ? `high ${snap.sessionHigh} -> ${patch.sessionHigh.toFixed(2)}. ` : '') +
        `MFE/MAE for this position was wrong until now.`,
    );
  }

  logger.info(
    `[Repair] Session extremes checked for ${snapshots.length} position(s) — ${repaired} corrected.`,
  );
}
