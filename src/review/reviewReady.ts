/**
 * The trigger for the adaptation loop: announce round trips whose outcome just became
 * knowable.
 *
 * `write_lesson` and the LESSONS block gave the system a way to carry a conclusion across a
 * cycle boundary, and a standard for what deserves to be one — but nothing that put the
 * model in front of an outcome. Cycles wake on market conditions, so the model was always
 * mid-tape, dealing with the live situation. This is the missing edge: a trade closed, its
 * result is arithmetic now rather than an opinion, and that is the one moment reflection is
 * grounded in something.
 *
 * Not a `Detector`, on purpose. Detectors are pure functions of a `TickData` snapshot,
 * evaluated every tick; a round trip is neither in that snapshot nor a level, and reading a
 * growing ledger sixty times an hour to re-derive a fact that changes a few times a day is
 * the wrong shape. It hangs off the reconciler instead — the only code that already knows
 * when the ledger changed.
 *
 * `warn`, deliberately: it renders as its own line in the cycle context and reaches the
 * operator, but wakes nobody. The trade is closed. There is nothing to act on, and burning a
 * cycle to say so would make reflection cost more than it returns.
 */

import { logger } from '../core/logger';
import { publishDiscrete, type EvidenceValue, type TriggerEvent } from '../features/eventBus';
import type { Policy } from '../policy/types';
import { getState, updateState } from '../state/state';
import { computeOutcomes, type TradeOutcome } from './ledger';

/**
 * How many closed trades to spell out in the evidence.
 *
 * Past this the block stops being readable and `get_scorecard` is one call away — and unlike
 * a truncated LESSONS list, that tool genuinely reaches the rest, so saying how many were
 * omitted is a pointer rather than an invitation to fill in the gap.
 */
const MAX_DETAILED = 5;

function money(n: number): string {
  return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
}

function describe(o: TradeOutcome): EvidenceValue {
  return {
    symbol: o.symbol,
    qty: o.qty,
    entryPrice: o.entryPrice,
    exitPrice: o.exitPrice,
    grossPnL: o.grossPnL,
    returnPct: o.returnPct,
    holdingHours: +(o.holdingMs / 3_600_000).toFixed(1),
    exitAt: o.exitAt,
    // The two fields that decide whether this outcome can be reasoned about at all.
    entryRationale: o.entryRationale ?? 'not recorded',
    exitRationale: o.exitRationale ?? 'not recorded',
    intendedStop: o.intendedStop ?? 'not recorded',
    policyVersion: o.policyVersion ?? 'unknown',
    unexplained: o.unexplained,
  };
}

/**
 * Fire once for the round trips that closed since the last announcement, and advance the
 * watermark. Returns the events to route — none when nothing closed.
 *
 * Never throws. It runs inside the scheduler's reconcile step, and a review nudge is the
 * least important thing a tick does: a bad read here must not cost the fills reconciliation
 * that ran just before it.
 */
export function publishReviewReady(policy: Policy): TriggerEvent[] {
  try {
    const outcomes = computeOutcomes();
    if (outcomes.length === 0) return [];

    // Oldest-first by construction, but the watermark is a max over `exitAt` and a scale-out
    // can close a later-entered position first, so do not assume the last one is the newest.
    const newest = outcomes.reduce((a, o) => (o.exitAt > a ? o.exitAt : a), '');
    const watermark = getState().lastReviewedExitAt;

    // First run against an existing ledger. Adopt the present rather than announcing a
    // backlog: months of exits arriving as one event is a wall the model would ack and
    // ignore, and it teaches nothing that `get_scorecard` does not already measure.
    if (watermark === '') {
      updateState({ lastReviewedExitAt: newest });
      logger.info(
        `[Review] Watching for closed round trips from ${newest} — ` +
          `${outcomes.length} already in the ledger, not announced.`,
      );
      return [];
    }

    const fresh = outcomes.filter((o) => o.exitAt > watermark);
    if (fresh.length === 0) return [];

    const net = fresh.reduce((sum, o) => sum + o.grossPnL, 0);
    const symbols = [...new Set(fresh.map((o) => o.symbol))];
    const winners = fresh.filter((o) => o.grossPnL > 0).length;

    const shown = fresh.slice(-MAX_DETAILED);
    const event = publishDiscrete(
      'review_ready',
      {
        // No single symbol owns the event once more than one closed.
        symbol: fresh.length === 1 ? fresh[0].symbol : null,
        cooldownKey: 'review_ready',
        severity: 'warn',
        headline:
          `${fresh.length} round trip(s) closed since your last review — ` +
          `${winners}W/${fresh.length - winners}L, net ${money(net)} gross (${symbols.join(', ')})`,
        evidence: {
          closed: fresh.length,
          winners,
          losers: fresh.length - winners,
          netGrossPnL: +net.toFixed(2),
          symbols,
          trades: shown.map(describe),
          ...(fresh.length > shown.length
            ? { omitted: fresh.length - shown.length, omittedNote: 'get_scorecard covers every round trip.' }
            : {}),
        },
        suggestedAction: 'reflect',
      },
      policy,
    );

    // After publishing, not before: a throw between the two would otherwise lose the
    // announcement permanently, and re-announcing is merely noisy.
    updateState({ lastReviewedExitAt: newest });
    return [event];
  } catch (err: any) {
    logger.warn(`[Review] Could not check for closed round trips: ${err?.message ?? String(err)}`);
    return [];
  }
}
