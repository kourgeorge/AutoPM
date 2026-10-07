import crypto from 'crypto';
import { broker } from '../broker';
import { getState, getPositionSnapshot, upsertPositionSnapshot, type Action } from '../state/state';
import { sameSymbol, isCryptoSymbol } from '../core/symbols';
import { canTighten, canLowerTakeProfit, moveStopTo, moveOcoTo } from './stopOrders';
import { decision, recordDecision, recordDecisionOutcome } from '../journal/journal';
import { transaction } from '../core/storage';

export interface AnnotateInput {
  symbol: string;
  stopLoss: number;
  takeProfit?: number | null;
  thesis: string;
  entryPrice?: number | null;
}

export type AnnotationValidation =
  | { ok: false; response: string }
  | {
      ok: true;
      symbol: string;
      stopLoss: number;
      takeProfit: number | null;
      thesis: string;
      effectiveEntry: number;
      heldQty: number;
      snapEntryPriceMissing: boolean;
    };

/**
 * Everything `toolAnnotatePosition` knows once the position, price and tighten-only checks
 * have passed. Pure — reads the broker/state but writes nothing, so it is safe for
 * `actionExecutor.ts` to re-run from scratch against whatever the position looks like by
 * the time a human decides, not against what it looked like when the action was created.
 */
export async function validateAnnotation(input: AnnotateInput): Promise<AnnotationValidation> {
  if (getState().paused) return { ok: false, response: JSON.stringify({ error: 'Trading is paused' }) };

  const { symbol, stopLoss, thesis } = input;
  const takeProfit = input.takeProfit ?? null;
  const providedEntryPrice = input.entryPrice ?? undefined;
  if ([stopLoss, takeProfit].some(level => level != null && (!Number.isFinite(level) || Math.abs(level * 100 - Math.round(level * 100)) > 1e-8))) return { ok: false, response: JSON.stringify({ error: 'Stop and target prices must use whole cents' }) };

  // Confirm the position is live at the venue — annotating a phantom is worse than
  // doing nothing, because it creates a stop the detector will report on air.
  const positions = await broker.getPositions();
  // `sameSymbol`, not `===`: the model quotes the symbol as the portfolio renders it, which
  // for crypto is the snapshot's `BTC/USD` against the venue's `BTCUSD`. An exact match
  // reported "no open position" for a position sitting right there in the same context.
  const held = positions.find(p => sameSymbol(p.symbol, symbol));
  if (!held) {
    return { ok: false, response: JSON.stringify({ error: `No open position in ${symbol} at the venue — nothing to annotate` }) };
  }

  // Entry price: the snapshot if it has one, else the caller's, else the venue's cost
  // basis. The venue fallback is why this can no longer fail for want of a number the
  // broker already told us.
  const snap = getPositionSnapshot(symbol);
  if (held.qty <= 0 || !Number.isInteger(held.qty) || isCryptoSymbol(symbol)) return { ok: false, response: JSON.stringify({ error: 'Only whole-share long equities can be managed' }) };
  if (!snap) return { ok: false, response: JSON.stringify({ error: 'Adopt this position explicitly before the bot manages it' }) };

  const effectiveEntry = snap?.entryPrice ?? providedEntryPrice ?? held.avgCost;

  // Same shape as toolExecuteExit's exit price. Degrades to the cost basis when the broker
  // omits marketValue, which is the pre-existing convention for "no better number".
  const currentPrice = held.marketValue != null && held.qty > 0 ? held.marketValue / held.qty : NaN;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { ok: false, response: JSON.stringify({ error: `Cannot determine a current price for ${symbol} — refusing to set a stop against an unknown level` }) };
  }

  if (!(stopLoss > 0 && stopLoss < currentPrice)) {
    return {
      ok: false,
      response: JSON.stringify({
        error: stopLoss >= currentPrice
          ? `stopLoss $${stopLoss} is at or above the current price $${currentPrice.toFixed(2)} — that level is already breached, use execute_exit if you want out`
          : `stopLoss $${stopLoss} must be above zero and below the current price $${currentPrice.toFixed(2)}`,
      }),
    };
  }
  if (takeProfit != null && takeProfit <= currentPrice) {
    return { ok: false, response: JSON.stringify({ error: `takeProfit $${takeProfit} must be above the current price $${currentPrice.toFixed(2)}` }) };
  }

  // Tighten-only. `canTighten` is shared with the stop sweep so the tool and the repair pass
  // cannot come to different conclusions about what counts as loosening.
  //
  // Journalled as a veto with a machine-readable rule, exactly like the guards in
  // `orderManager`, because the interesting question is not this one refusal — it is the pattern
  // across a month.
  if (!canTighten(snap?.stopLevel, stopLoss)) {
    return {
      ok: false,
      response: JSON.stringify({
        error: `stopLoss $${stopLoss} is below the stop already recorded for ${symbol} ($${snap!.stopLevel}). `
          + `Stops are tighten-only: they can be raised or restated, never widened. If the thesis has `
          + `changed enough that the old stop is wrong, exit the position rather than giving it more room.`,
        rejectedBy: 'guard',
        rule: 'stop_loosened',
        recordedStop: snap!.stopLevel,
      }),
    };
  }

  // Mirror check for the take-profit side: it may only move toward the market, never further
  // away. Only checked when the caller actually supplied one — omitting takeProfit leaves the
  // recorded level, if any, untouched.
  if (takeProfit != null && !canLowerTakeProfit(snap?.takeProfitLevel, takeProfit)) {
    return {
      ok: false,
      response: JSON.stringify({
        error: `takeProfit $${takeProfit} is above the take-profit already recorded for ${symbol} ($${snap!.takeProfitLevel}). `
          + `Take-profits are tighten-only: they can be lowered toward the market or restated, never raised `
          + `further away. If the thesis has changed enough that the old target is wrong, exit the position `
          + `rather than pushing the target further out.`,
        rejectedBy: 'guard',
        rule: 'take_profit_loosened',
        recordedTakeProfit: snap!.takeProfitLevel,
      }),
    };
  }

  return {
    ok: true,
    symbol,
    stopLoss,
    takeProfit,
    thesis,
    effectiveEntry,
    heldQty: held.qty,
    snapEntryPriceMissing: snap?.entryPrice == null,
  };
}

/**
 * Records the hold decision, writes the baselines, and makes the venue agree. Never called
 * until a `validateAnnotation` has passed — and, on the manual path, until a human has
 * approved: recording a tighter stop that is then rejected would misreport what this system
 * believes protects the position, which is the reason this is a separate function at all.
 */
export async function actAnnotation(v: Extract<AnnotationValidation, { ok: true }>, action?: Action): Promise<string> {
  const id = action ? 'action-' + action.id : crypto.randomUUID();
  const old = getPositionSnapshot(v.symbol);
  if (!old) throw new Error('Position is no longer managed');
  transaction(() => {
    recordDecision(decision('adjustment', 'trader', {
      symbol: v.symbol, rationale: v.thesis, intendedStop: v.stopLoss, intendedTarget: v.takeProfit,
      actionId: action?.id, requestId: action?.requestId, actorId: action?.requestedBy,
      orderStatus: 'executing', protectionStatus: 'pending',
    }), id);
    upsertPositionSnapshot(v.symbol, { stopLevel: v.stopLoss,
      ...(v.takeProfit != null ? { takeProfitLevel: v.takeProfit } : {}), managementDecisionId: id });
  });
  const target = v.takeProfit ?? old.takeProfitLevel;
  try {
    if (target != null) {
      const result = await moveOcoTo(v.symbol, v.heldQty, v.stopLoss, target);
      recordDecisionOutcome(id, { executed: result.ok, protectionStatus: result.ok ? 'confirmed' : 'unknown',
        venueStopId: result.ok ? result.stopOrderId : null, venueStopMissing: result.ok ? null : result.reason,
        orderStatus: result.ok ? 'executed' : 'unknown' });
      return JSON.stringify({ ok: result.ok, decisionId: id, venueOco: result.ok ? result : { stopOrderId: null, note: result.reason } });
    }
    const result = await moveStopTo(v.symbol, v.heldQty, v.stopLoss);
    recordDecisionOutcome(id, { executed: result.ok, protectionStatus: result.ok ? 'confirmed' : 'unknown',
      venueStopId: result.ok ? result.orderId : null, venueStopMissing: result.ok ? null : result.reason,
      orderStatus: result.ok ? 'executed' : 'unknown' });
    return JSON.stringify({ ok: result.ok, decisionId: id, venueStop: result.ok ? result : { orderId: null, note: result.reason } });
  } catch (err: any) {
    recordDecisionOutcome(id, { protectionStatus: 'unknown', orderStatus: 'unknown', venueStopMissing: err.message });
    throw err;
  }
}
