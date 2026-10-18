/**
 * The machine-owned trailing stop: raise each held position's stop to a fixed ATR distance
 * below the highest price since entry, never lower it.
 *
 * Deterministic on purpose. The trader wakes on events and sleeps between cycles, so a stop it
 * has to remember to raise lags every run-up and hands the gain back on the way down. Exits and
 * risk limits belong to code the model cannot argue with (FinRobot, Senpi's runtime, Condor's
 * OODA split all draw the same line). The trader keeps its own lever: `annotate_position` can
 * still tighten past the trail for a reason — earnings coming, thesis weakening — and the trail
 * will never undo that, because it only ever moves a stop up.
 *
 * Inputs are the tick's own numbers: `sessionHigh` is already a trade-confirmed running high
 * (a phantom quote cannot set it, see `baselines` in compute.ts) and `atr` is the daily ATR the
 * detectors use. A stale tick moves nothing.
 */

import type { TickData, PositionData } from '../features/compute';
import type { Policy } from '../policy/types';
import { getPositionSnapshot, upsertPositionSnapshot, getState } from '../state/state';
import { canTighten, isStopLocked, moveStopTo, moveOcoTo } from './stopOrders';
import { protectionIntents } from './protectionIntent';
import { pendingOrders } from '../core/orders';
import { canonicalSymbol } from '../core/symbols';
import { decision, recordDecision, recordDecisionOutcome } from '../journal/journal';
import { transaction } from '../core/storage';
import { logger } from '../core/logger';
import crypto from 'crypto';

/**
 * Smallest raise worth a broker replace, as a fraction of price. Without it a high that inches
 * up a cent at a time replaces the order every minute — each one a request the venue can refuse
 * and a line in the journal nobody reads.
 */
export const MIN_RAISE_FRACTION = 0.0025;

export interface TrailPlan {
  symbol: string;
  qty: number;
  from: number | null;
  to: number;
  sessionHigh: number;
  atr: number;
}

/**
 * Where the stop should be now, or null to leave it.
 *
 * Null when: the trail is off; any input is missing; the trailed level is not above the recorded
 * stop by at least `MIN_RAISE_FRACTION`; or the level would sit at or above the current price —
 * that is a breach for the stop detector and the trader to handle with a reason, not an order
 * for the trail to place.
 */
export function trailTarget(pos: PositionData, recordedStop: number | null | undefined, mult: number | null | undefined): number | null {
  if (mult == null || !(mult > 0)) return null;
  const { price, sessionHigh, atr } = pos;
  if (pos.stale || price == null || !(price > 0) || !(sessionHigh > 0) || atr == null || !(atr > 0)) return null;
  if (recordedStop == null || !(recordedStop > 0)) return null; // nothing armed yet; entry owns the first stop
  const to = Math.floor((sessionHigh - mult * atr) * 100) / 100;
  if (!(to > 0) || to >= price) return null;
  if (!canTighten(recordedStop, to) || to - recordedStop < price * MIN_RAISE_FRACTION) return null;
  return to;
}

/** Every held position whose stop the trail would raise this tick. Pure. */
export function trailPlans(data: TickData, policy: Policy, snapshots = getState().positionSnapshots): TrailPlan[] {
  const mult = policy.risk.trailingStopAtrMult;
  if (mult == null || policy.automation.level.stopAdjust !== 'auto') return [];
  if (data.positionsStale || data.ordersStale) return [];
  const out: TrailPlan[] = [];
  for (const pos of Object.values(data.positions)) {
    if (!(pos.qty > 0) || !Number.isInteger(pos.qty)) continue;
    const snap = snapshots[canonicalSymbol(pos.symbol)];
    if (!snap) continue; // unmanaged holding: adoption comes first
    const to = trailTarget(pos, snap.stopLevel, mult);
    if (to == null) continue;
    out.push({ symbol: pos.symbol, qty: pos.qty, from: snap.stopLevel ?? null, to, sessionHigh: pos.sessionHigh, atr: pos.atr! });
  }
  return out;
}

/**
 * Move the resting stops. Runs after the tick's detectors, so a breach is routed before the
 * trail touches anything.
 *
 * Skipped per symbol while anything else owns it: an exit or entry in flight (the stop lock),
 * an order waiting on this symbol, or a protection request whose outcome is unknown. Each raise
 * is journalled as an `adjustment` by the guard, so the record shows the machine moved it, not
 * the trader.
 */
export async function trailStops(data: TickData, policy: Policy): Promise<void> {
  const plans = trailPlans(data, policy);
  if (!plans.length || getState().paused) return;
  const busy = new Set(pendingOrders().map(o => canonicalSymbol(o.symbol)));
  for (const [key, intent] of Object.entries(protectionIntents())) if (intent.status !== 'confirmed') busy.add(key);

  for (const plan of plans) {
    const key = canonicalSymbol(plan.symbol);
    if (busy.has(key) || isStopLocked(key)) continue;
    // Re-read: the trader or a sweep may have moved it during an earlier await in this loop.
    const snap = getPositionSnapshot(key);
    if (!snap || !canTighten(snap.stopLevel, plan.to) || snap.stopLevel === plan.to) continue;

    const id = 'trail-' + crypto.randomUUID();
    const rationale = `Trailing stop raised from $${plan.from} to $${plan.to}: `
      + `${policy.risk.trailingStopAtrMult} ATR ($${plan.atr.toFixed(2)}) below the high since entry ($${plan.sessionHigh}).`;
    transaction(() => {
      recordDecision(decision('adjustment', 'guard', {
        symbol: key, rationale, intendedStop: plan.to, intendedTarget: snap.takeProfitLevel ?? null,
        orderStatus: 'executing', protectionStatus: 'pending',
      }), id);
      upsertPositionSnapshot(key, { stopLevel: plan.to });
    });
    try {
      const result = snap.takeProfitLevel != null
        ? await moveOcoTo(plan.symbol, plan.qty, plan.to, snap.takeProfitLevel)
        : await moveStopTo(plan.symbol, plan.qty, plan.to);
      const venueStopId = !result.ok ? null : 'stopOrderId' in result ? result.stopOrderId : result.brokerOrderId;
      // `protect` marks an uncertain broker answer `unknown` and pauses trading. Anything else
      // that failed was refused before an order left, so the old stop still rests at the old
      // level: put the record back to say so, and the next tick tries again. The uncertain case
      // keeps the higher level, as an approved manual adjustment does, for the operator to review.
      const uncertain = !result.ok && protectionIntents()[key]?.status === 'unknown';
      recordDecisionOutcome(id, { executed: result.ok, orderStatus: result.ok ? 'executed' : uncertain ? 'unknown' : 'failed',
        protectionStatus: result.ok ? 'confirmed' : 'unknown', venueStopId, venueStopMissing: result.ok ? null : result.reason });
      if (result.ok) logger.trade(`[Trail] ${key} stop raised $${plan.from} → $${plan.to}`);
      else {
        if (!uncertain && getPositionSnapshot(key)?.stopLevel === plan.to) upsertPositionSnapshot(key, { stopLevel: plan.from ?? undefined });
        logger.warn(`[Trail] ${key} stop could not be raised to $${plan.to}: ${result.reason}`);
      }
    } catch (err: any) {
      recordDecisionOutcome(id, { orderStatus: 'unknown', protectionStatus: 'unknown', venueStopMissing: err?.message ?? String(err) });
      logger.warn(`[Trail] ${key}: ${err?.message ?? err}`);
    }
  }
}
