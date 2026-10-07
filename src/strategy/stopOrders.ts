import { protect, protectionIntents } from './protectionIntent';
import { assertExecutionOwner } from '../core/runtime';
/**
 * L4 — the stop that rests at the venue.
 *
 * Before this, a stop was a number in `positionSnapshots[sym].stopLevel` and nothing else. The
 * `stop_breach` detector compared the price against it once a minute, published an event, and the
 * model called `execute_exit`. Three links, and all three fail together the moment this process
 * is not running: no tick, no event, no exit. Overnight, over a weekend, or through a crash, a
 * position had no protection of any kind.
 *
 * So the recorded level now also exists as a real resting sell stop at the broker. The recorded
 * level does not go away — it is still the detector's input and still what the model reasons
 * about — it just stops being the only thing standing between the book and a gap down.
 *
 * The split in this file is deliberate and follows `restingSells` in `orderManager.ts`: the
 * DECISIONS are pure and exported (`stopOrderFor`, `needsArming`, `canTighten`) and the ACTING is
 * not. `broker` is a module-level singleton with no injection seam, so a pure decision is the
 * only part the replay harness can assert without a live venue — and the decisions are the part
 * worth pinning anyway.
 */

import { broker } from '../broker';
import { getOpenActions } from '../core/actions';
import type { OcoRequest, OpenOrder, OrderRequest, Position } from '../broker/IBroker';
import { logger } from '../core/logger';
import { canonicalSymbol, isCryptoSymbol, sameSymbol } from '../core/symbols';
import {
  getPositionSnapshot,
  getState,
  patchPositionSnapshot,
  removePositionSnapshot,
  type PositionSnapshot,
} from '../state/state';

// ── Pure decisions ────────────────────────────────────────────────────────────

export type StopPlan =
  | { ok: true; request: OrderRequest }
  | { ok: false; reason: string };

export type OcoPlan =
  | { ok: true; request: OcoRequest }
  | { ok: false; reason: string };

/**
 * The checks `stopOrderFor` and `ocoOrderFor` share: is this symbol/qty combination something a
 * protective sell order can even be placed against, independent of what the level(s) are.
 */
function guardProtectable(symbol: string, qty: number): { ok: false; reason: string } | null {
  if (isCryptoSymbol(symbol)) {
    return {
      ok: false,
      reason: `${symbol} is a crypto pair — the venue accepts market, limit and stop_limit for `
        + `crypto and rejects a plain stop, so no stop can rest here. The recorded level is `
        + `watched by the breach detector only, which means only while this process runs.`,
    };
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    // A short position's protection is a BUY stop above the market, not a sell stop below it.
    // Nothing in this system opens one (`enterPosition` is buy-only), but an inherited book can
    // hold one, and guessing the side on it would place an order that doubles the position.
    return {
      ok: false,
      reason: qty < 0
        ? `${symbol} is a short position (qty ${qty}) — a protective stop on a short is a buy `
          + `stop above the market, which this system does not place`
        : `${symbol} has no positive qty to protect (got ${qty})`,
    };
  }
  return null;
}

/**
 * The order that would protect this position, or the reason no order can.
 *
 * A reason rather than a bare `null` because every caller has to report it: "no venue stop" and
 * "no venue stop because Alpaca will not take a plain stop on a coin" are different facts, and
 * the model asked to manage the position needs the second one. Silence here is what makes a
 * missing stop look like an oversight instead of a constraint.
 */
export function stopOrderFor(symbol: string, qty: number, stopLevel: number): StopPlan {
  const guard = guardProtectable(symbol, qty);
  if (guard) return guard;
  if (!Number.isFinite(stopLevel) || stopLevel <= 0) {
    return { ok: false, reason: `${symbol} has no usable stop level recorded (got ${stopLevel})` };
  }
  return {
    ok: true,
    request: { symbol, side: 'sell', qty, type: 'stop', stopPrice: stopLevel },
  };
}

/**
 * The linked stop + take-profit pair that would protect this position, or the reason no pair
 * can. Same refusal shape and same crypto/short/qty guard as `stopOrderFor` — a stop and a
 * take-profit leg fail for the same venue reasons — plus one refusal unique to the pair: a
 * target that is not above the stop can't bracket anything.
 */
export function ocoOrderFor(
  symbol: string,
  qty: number,
  stopLevel: number,
  takeProfitLevel: number,
): OcoPlan {
  const guard = guardProtectable(symbol, qty);
  if (guard) return guard;
  if (!Number.isFinite(stopLevel) || stopLevel <= 0) {
    return { ok: false, reason: `${symbol} has no usable stop level recorded (got ${stopLevel})` };
  }
  if (!Number.isFinite(takeProfitLevel) || takeProfitLevel <= 0) {
    return { ok: false, reason: `${symbol} has no usable take-profit level recorded (got ${takeProfitLevel})` };
  }
  if (takeProfitLevel <= stopLevel) {
    return {
      ok: false,
      reason: `${symbol} take-profit $${takeProfitLevel} is not above stop $${stopLevel} — `
        + `can't bracket a position with an inverted target`,
    };
  }
  return {
    ok: true,
    request: { symbol, qty, stopPrice: stopLevel, takeProfitPrice: takeProfitLevel },
  };
}

/** A live sell stop resting for this symbol, if there is one. */
export function restingStop(orders: OpenOrder[], symbol: string): OpenOrder | undefined {
  return orders.find(o => o.side === 'sell' && o.type === 'stop' && sameSymbol(o.symbol, symbol));
}

/** A live sell limit (take-profit) order resting for this symbol, if there is one. */
export function restingTakeProfit(orders: OpenOrder[], symbol: string): OpenOrder | undefined {
  return orders.find(o => o.side === 'sell' && o.type === 'limit' && sameSymbol(o.symbol, symbol));
}

/**
 * How many shares are still free to be reserved by a new sell order, optionally ignoring one
 * order id already resting.
 *
 * The venue counts what nothing else has a claim on, not what is owned — the same arithmetic
 * `restingSells` documents. A hand-placed take-profit limit over half the position leaves half
 * the position stoppable, and arming for the full qty there is not "more protection", it is an
 * order the venue refuses every single tick.
 *
 * `ignoreOrderId` exists for the OCO repair path: cancelling a lone leg before re-arming frees
 * its qty, and the candidate has to be sized against that FUTURE state, not the current one
 * where the stale leg still shows as reserved.
 */
function freeQty(position: Position, orders: OpenOrder[], ignoreOrderId?: string): number {
  const reserved = orders
    .filter(o => o.side === 'sell' && sameSymbol(o.symbol, position.symbol) && o.id !== ignoreOrderId)
    .reduce((sum, o) => sum + Math.max(0, o.qty - o.filled), 0);
  return position.qty - reserved;
}

export interface ArmCandidate {
  /** The VENUE's spelling, because this is what gets placed. */
  symbol: string;
  qty: number;
  stopLevel: number;
}

/**
 * Positions held at the venue with a recorded stop and nothing resting to enforce it.
 *
 * Pure, and joined on `sameSymbol` throughout: the venue reports `BTCUSD` where the snapshot may
 * be keyed from `BTC/USD`, and a bare `===` here would read a protected position as naked and
 * arm a second stop over the same shares.
 *
 * A position already at or through its recorded stop is deliberately SKIPPED. Arming there would
 * trigger instantly — an autonomous exit with no journal entry and no rationale — and the breach
 * detector already owns that case with a path that records why. Only skipped when the mark can
 * actually be measured; `marketValue` is optional in `IBroker`, and without it the venue decides.
 */
export function needsArming(
  positions: Position[],
  orders: OpenOrder[],
  snapshots: Record<string, PositionSnapshot>,
): ArmCandidate[] {
  const out: ArmCandidate[] = [];

  for (const p of positions) {
    if (isCryptoSymbol(p.symbol) || p.qty <= 0) continue;

    const snap = snapshots[canonicalSymbol(p.symbol)];
    // A recorded take-profit means this position belongs to the OCO pair, owned exclusively by
    // `needsOcoAction` below — arming a lone stop here as well would double-reserve the qty the
    // pair needs and race the pair's own arm/repair logic over the same order.
    if (snap?.takeProfitLevel != null && snap.takeProfitLevel > 0) continue;

    const stopLevel = snap?.stopLevel;
    if (stopLevel == null || !(stopLevel > 0)) continue;

    if (restingStop(orders, p.symbol)) continue;

    const qty = freeQty(p, orders);
    if (!(qty > 0)) continue;

    const mark = p.marketValue != null && p.qty !== 0 ? p.marketValue / p.qty : null;
    if (mark != null && Number.isFinite(mark) && mark > 0 && stopLevel >= mark) continue;

    out.push({ symbol: p.symbol, qty, stopLevel });
  }

  return out;
}

export type OcoAction =
  | { kind: 'arm'; symbol: string; qty: number; stopLevel: number; takeProfitLevel: number }
  | {
      kind: 'repair';
      symbol: string;
      qty: number;
      stopLevel: number;
      takeProfitLevel: number;
      staleLegId: string;
      staleLegSide: 'stop' | 'takeProfit';
    };

/**
 * Positions holding BOTH a recorded stop and a recorded take-profit, and what the venue book
 * needs to do about them.
 *
 * Four states per position, same join discipline as `needsArming` (`sameSymbol`, skip when
 * already through either level with a measurable mark):
 *  - both legs resting → nothing to do, not returned.
 *  - neither leg resting → `arm` the pair fresh.
 *  - exactly one leg resting (a position protected before this feature existed, or a prior
 *    failed pairing) → `repair`: the lone leg is stale and must be cancelled before the pair can
 *    be armed, since the venue will not accept a second full-qty sell alongside it. The qty for
 *    the fresh pair is sized against the state AFTER that cancellation (`freeQty`'s
 *    `ignoreOrderId`), not the current one where the stale leg still reserves shares.
 */
export function needsOcoAction(
  positions: Position[],
  orders: OpenOrder[],
  snapshots: Record<string, PositionSnapshot>,
): OcoAction[] {
  const out: OcoAction[] = [];

  for (const p of positions) {
    if (isCryptoSymbol(p.symbol) || p.qty <= 0) continue;

    const snap = snapshots[canonicalSymbol(p.symbol)];
    const stopLevel = snap?.stopLevel;
    const takeProfitLevel = snap?.takeProfitLevel;
    if (stopLevel == null || !(stopLevel > 0)) continue;
    if (takeProfitLevel == null || !(takeProfitLevel > 0)) continue;

    const mark = p.marketValue != null && p.qty !== 0 ? p.marketValue / p.qty : null;
    const markKnown = mark != null && Number.isFinite(mark) && mark > 0;
    if (markKnown && (stopLevel >= mark! || takeProfitLevel <= mark!)) continue;

    const stopLeg = restingStop(orders, p.symbol);
    const tpLeg = restingTakeProfit(orders, p.symbol);

    if (stopLeg && tpLeg) continue;

    if (!stopLeg && !tpLeg) {
      const qty = freeQty(p, orders);
      if (!(qty > 0)) continue;
      out.push({ symbol: p.symbol, qty, stopLevel, takeProfitLevel, kind: 'arm' });
      continue;
    }

    const staleLeg = stopLeg ?? tpLeg!;
    const qty = freeQty(p, orders, staleLeg.id);
    if (!(qty > 0)) continue;
    out.push({
      symbol: p.symbol,
      qty,
      stopLevel,
      takeProfitLevel,
      kind: 'repair',
      staleLegId: staleLeg.id,
      staleLegSide: stopLeg ? 'stop' : 'takeProfit',
    });
  }

  return out;
}

/**
 * Snapshot keys with no position behind them at the venue.
 *
 * The map mixes two kinds of fact under one key: WHICH symbols have a record, which is a fact
 * about the venue's book, and WHAT the record says, which is a fact only this system knows. The
 * second half is why the file exists; the first half cannot be maintained by whoever happens to
 * be acting, because a position can end without this system being asked. `execute_exit` removes
 * its own snapshot, but a venue stop firing, a close placed by hand, and a close while this
 * process was down all leave the record behind — and four of them had accumulated by the time
 * anyone looked.
 *
 * Pure, and it decides nothing about what to do: absence from ONE read is not proof a position
 * closed. The caller owns that judgment.
 *
 * `qty !== 0` rather than `> 0`: a short is held, and a held position's recorded level must
 * survive even though `needsArming` rightly refuses to arm a sell stop over it.
 */
export function unheldSnapshots(
  positions: Position[],
  snapshots: Record<string, PositionSnapshot>,
): string[] {
  const held = new Set(
    positions.filter(p => p.qty !== 0).map(p => canonicalSymbol(p.symbol)),
  );
  return Object.keys(snapshots).filter(key => !held.has(key));
}

/**
 * Tighten-only: a stop may be raised or restated, never widened.
 *
 * `>=` rather than `>` on purpose — re-asserting the level already recorded is not loosening it,
 * and refusing that would turn an idempotent retry into a rule violation.
 *
 * No recorded level yet means there is nothing to loosen, so anything is a tightening. The
 * caller still has to check the level against the market; that is not this predicate's job.
 */
export function canTighten(current: number | undefined | null, next: number): boolean {
  if (!Number.isFinite(next) || next <= 0) return false;
  if (current == null || !Number.isFinite(current) || current <= 0) return true;
  return next >= current;
}

/**
 * Tighten-only, mirrored: a take-profit may be lowered toward the market or restated, never
 * raised further away.
 *
 * Same "never loosen protection" discipline as `canTighten`, on the other side of the position —
 * a take-profit that keeps moving up is a target that keeps getting harder to reach, which is a
 * risk decision dressed up as a tighten.
 */
export function canLowerTakeProfit(current: number | undefined | null, next: number): boolean {
  if (!Number.isFinite(next) || next <= 0) return false;
  if (current == null || !Number.isFinite(current) || current <= 0) return true;
  return next <= current;
}

// ── The symbol lock ───────────────────────────────────────────────────────────

/**
 * Symbols whose stop is being changed by a deliberate operation right now, which the sweep
 * must leave alone.
 *
 * Two races, both real, both caused by the sweep being helpful at the wrong instant:
 *
 *  - EXIT. `exitPosition` cancels every resting sell, then sells. A sweep landing in between
 *    sees a held position with a recorded level and no stop, re-arms, re-reserves the shares,
 *    and the market sell fails with `insufficient qty available` — the precise error the cancel
 *    loop exists to prevent.
 *  - ENTRY. During the fill-wait the position is live at the venue but its snapshot has not been
 *    written yet. Usually that means no recorded level and the sweep skips it — but a LEFTOVER
 *    snapshot from a previous closed trade in the same symbol is a documented fact of this
 *    system, and that leftover carries the OLD stop level. The sweep would arm at last trade's
 *    level while the entry arms at this one's.
 *
 * Keyed by `canonicalSymbol`: the sweep reads the venue's `BTCUSD` while the caller holds
 * `BTC/USD`, and a raw-string set would let through exactly what it exists to stop.
 *
 * It does not serialize its callers — the tools are already serial within a cycle, and an
 * operation asked for explicitly outranks a repair pass. It only keeps the sweep out.
 */
const busy = new Set<string>();

export async function withStopLock<T>(symbol: string, fn: () => Promise<T>): Promise<T> {
  const key = canonicalSymbol(symbol);
  busy.add(key);
  try {
    return await fn();
  } finally {
    busy.delete(key);
  }
}

export function isStopLocked(symbol: string): boolean {
  return busy.has(canonicalSymbol(symbol));
}

// ── Acting ────────────────────────────────────────────────────────────────────

export type ArmResult =
  | { ok: true; orderId: string }
  | { ok: false; reason: string };

/** Place a durable protective stop. Record its broker ID before confirming the intent. */
export async function armStop(symbol: string, qty: number, stopLevel: number): Promise<ArmResult> {
  const plan = stopOrderFor(symbol, qty, stopLevel);
  if (!plan.ok) return plan;

  try {
    await verifyFreeHolding(symbol, qty);
    const { id } = await protect(symbol, stopLevel, undefined, async clientOrderId => {
      const placed = await guardedBroker().placeOrder({ ...plan.request, clientOrderId });
      patchPositionSnapshot(symbol, { stopOrderId: placed.id });
      return placed;
    });
    logger.trade(`Stop armed for ${symbol}: ${qty} @ $${stopLevel} resting as ${id}`);
    return { ok: true, orderId: id };
  } catch (err: any) {
    return { ok: false, reason: err?.venueMessage ?? err?.message ?? String(err) };
  }
}

/** Confirm the existing owned stop, then request and record its replacement. */
export async function moveStopTo(
  symbol: string,
  qty: number,
  nextLevel: number,
): Promise<ArmResult> {
  return withStopLock(symbol, async () => {
    const existingId = getPositionSnapshot(symbol)?.stopOrderId;

    if (existingId) {
      try {
        const order = (await broker.getOpenOrders()).find(o => o.id === existingId && sameSymbol(o.symbol, symbol) && o.side === 'sell' && o.type === 'stop');
        if (!order) throw new Error('Recorded stop is not confirmed at the broker');
        if (order.stopPrice === nextLevel) return { ok: true as const, orderId: existingId };
        const { id } = await protect(symbol, nextLevel, undefined, async () => {
          const placed = await guardedBroker().replaceStopOrder(existingId, nextLevel);
          patchPositionSnapshot(symbol, { stopOrderId: placed.id });
          return placed;
        });
        patchPositionSnapshot(symbol, { stopOrderId: id });
        logger.trade(`Stop for ${symbol} moved to $${nextLevel} (order ${id})`);
        return { ok: true as const, orderId: id };
      } catch (err: any) {
        // Restating a stop at the level it already rests at is how a thesis or an earnings
        // date gets recorded, and Alpaca refuses that no-op replace with "order parameters are
        // not changed". The refusal SAYS the stop rests at `nextLevel` already, so it is the
        // success case — reporting it as a failed move told the model a protected position
        // had lost its stop (an observed false alarm on ADBE, 2026-08-29).
        const venueText = String(err?.venueMessage ?? err?.message ?? '');
        if (/parameters are not changed/i.test(venueText)) {
          logger.info(`[Stops] ${symbol}: stop already rests at $${nextLevel} (order ${existingId}) — nothing to move`);
          return { ok: true as const, orderId: existingId };
        }
        // The venue refused the move. The old stop may still be resting at the OLD level, so the
        // id is left alone rather than cleared — the sweep verifies it against the venue and
        // clears it there if it is genuinely gone. Guessing here would either discard a live
        // stop's id or keep a dead one; the sweep is the thing that can actually look.
        return {
          ok: false as const,
          reason: `could not move the resting stop (order ${existingId}): `
            + `${err?.venueMessage ?? err?.message ?? String(err)}`,
        };
      }
    }

    const armed = await armStop(symbol, qty, nextLevel);
    if (armed.ok) patchPositionSnapshot(symbol, { stopOrderId: armed.orderId });
    return armed;
  });
}

export type OcoArmResult =
  | { ok: true; stopOrderId: string; takeProfitOrderId: string }
  | { ok: false; reason: string };

/** Place a durable linked pair. An uncertain request pauses trading and cannot be repeated. */
export async function armOco(
  symbol: string,
  qty: number,
  stopLevel: number,
  takeProfitLevel: number,
): Promise<OcoArmResult> {
  const plan = ocoOrderFor(symbol, qty, stopLevel, takeProfitLevel);
  if (!plan.ok) return plan;

  try {
    await verifyFreeHolding(symbol, qty);
    const { stopOrderId, takeProfitOrderId } = await protect(symbol, stopLevel, takeProfitLevel, async clientOrderId => {
      const placed = await guardedBroker().placeOco({ ...plan.request, clientOrderId });
      patchPositionSnapshot(symbol, placed);
      return placed;
    });
    logger.trade(
      `OCO armed for ${symbol}: ${qty} @ stop $${stopLevel} / target $${takeProfitLevel} `
        + `resting as ${stopOrderId} / ${takeProfitOrderId}`,
    );
    return { ok: true, stopOrderId, takeProfitOrderId };
  } catch (err: any) {
    return { ok: false, reason: err?.venueMessage ?? err?.message ?? String(err) };
  }
}

/** Replace confirmed owned legs in sequence, retaining each acknowledged broker ID. */
export async function moveOcoTo(
  symbol: string,
  qty: number,
  nextStop: number,
  nextTakeProfit: number,
): Promise<OcoArmResult> {
  return withStopLock(symbol, async () => {
    const snap = getPositionSnapshot(symbol);
    const existingStopId = snap?.stopOrderId;
    const existingTpId = snap?.takeProfitOrderId;

    if (existingStopId && existingTpId) {
      try {
        const orders = await broker.getOpenOrders();
        const stop = orders.find(o => o.id === existingStopId && sameSymbol(o.symbol, symbol) && o.type === 'stop');
        const target = orders.find(o => o.id === existingTpId && sameSymbol(o.symbol, symbol) && o.type === 'limit');
        if (!stop || !target) throw new Error('Both owned protective legs must be confirmed before adjustment');
        if (stop.stopPrice === nextStop && target.limitPrice === nextTakeProfit) return { ok: true, stopOrderId: stop.id, takeProfitOrderId: target.id };
        const placed = await protect(symbol, nextStop, nextTakeProfit, async () => {
          const stopResult = stop.stopPrice === nextStop ? stop : await guardedBroker().replaceStopOrder(existingStopId, nextStop);
          patchPositionSnapshot(symbol, { stopOrderId: stopResult.id });
          const targetResult = target.limitPrice === nextTakeProfit ? target : await guardedBroker().replaceTakeProfitOrder(existingTpId, nextTakeProfit);
          patchPositionSnapshot(symbol, { takeProfitOrderId: targetResult.id });
          return { stopOrderId: stopResult.id, takeProfitOrderId: targetResult.id };
        });
        return { ok: true, ...placed };
      } catch (err: any) { return { ok: false, reason: err.message }; }
    }
    if (existingStopId || existingTpId) return { ok: false, reason: 'One protective leg is missing; inspect broker orders before replacing the pair' };

    const armed = await armOco(symbol, qty, nextStop, nextTakeProfit);
    if (armed.ok) {
      patchPositionSnapshot(symbol, {
        stopOrderId: armed.stopOrderId,
        takeProfitOrderId: armed.takeProfitOrderId,
      });
    }
    return armed;
  });
}

/**
 * Failure reasons already logged, per symbol, so a position that cannot be armed does not
 * write the same warning every 60 seconds for the rest of the day. Cleared when the symbol
 * arms, or when it is no longer held — which also bounds the map at the size of the book.
 */
const lastFailure = new Map<string, string>();

/**
 * Consecutive sweeps in which a snapshot's symbol was not held, per canonical symbol.
 *
 * Deliberately in memory rather than in `state.json`: a restart resets the count and delays a
 * prune by one tick, which costs nothing, while persisting it would add a field that can go
 * stale in order to fix that nothing.
 */
const absentFor = new Map<string, number>();

/** Consecutive absences before a snapshot is believed to be a leftover. */
const ORPHAN_STRIKES = 2;

/**
 * The bar when the WHOLE book reads empty.
 *
 * A flat book and a broken read are the same bytes — a successful response carrying no positions
 * is exactly what a venue in trouble returns — and deleting a stop level cannot be undone, since
 * this file is the only place those levels exist. So a genuinely flat book waits five minutes to
 * be believed, and an ordinary close waits two ticks.
 */
const FLAT_BOOK_STRIKES = 5;

function logFailureOnce(symbol: string, reason: string): void {
  const key = canonicalSymbol(symbol);
  if (lastFailure.get(key) === reason) return;
  lastFailure.set(key, reason);
  logger.warn(`[Stops] ${symbol} is not protected at the venue — ${reason}`);
}

/** Protect managed holdings independently of research. Retain unresolved reservations and never cancel an external or surviving protective leg. */
export async function sweepStops(): Promise<void> {
  let positions: Position[];
  let orders: OpenOrder[];
  try {
    [positions, orders] = await Promise.all([broker.getPositions(), broker.getOpenOrders()]);
  } catch (err: any) {
    throw new Error(`Protection cannot read the broker: ${err?.message ?? err}`);
  }

  // An unconfirmed exit owns its reservation until reconciliation establishes the outcome.
  const exiting = new Set(getOpenActions().filter(p => ['executing','submitted','partial','unknown'].includes(p.status)).map(p => canonicalSymbol(p.symbol)));
  for (const [key, intent] of Object.entries(protectionIntents())) if (intent.status !== 'confirmed') exiting.add(key);
  positions = positions.filter(p => !exiting.has(canonicalSymbol(p.symbol)));

  // Forget failures for symbols no longer held, so the map cannot grow past the book.
  for (const key of [...lastFailure.keys()]) {
    if (!positions.some(p => canonicalSymbol(p.symbol) === key)) lastFailure.delete(key);
  }

  // A snapshot may exist only for a symbol currently held. This is the pass that holds that
  // invariant; `execute_exit` removing its own is a fast path, not the guarantee.
  //
  // The removed record is printed in full because a snapshot vanishing silently is how the
  // question gets asked again in three weeks. Nothing else needs saving: the reason lives in
  // `journal.jsonl` and the money in `fills.jsonl`. `sessionHigh`/`sessionLow` do go, and they
  // exist nowhere else — but nothing reads them for a closed trade, and the answer if that
  // changes is to derive MFE/MAE from minute bars since `openedAt`, not to keep a second history.
  const snapshots = getState().positionSnapshots;
  const unheld = new Set(unheldSnapshots(positions, snapshots));
  for (const key of [...absentFor.keys()]) if (!unheld.has(key)) absentFor.delete(key);

  const needed = positions.length === 0 ? FLAT_BOOK_STRIKES : ORPHAN_STRIKES;
  for (const key of unheld) {
    // An exit or an entry mid-flight owns this symbol: during the fill-wait the position can be
    // live at the venue before the read that produced `positions`, and `execute_exit` removes
    // the snapshot itself the moment its sell is accepted.
    if (isStopLocked(key) || exiting.has(key)) continue;

    const strikes = (absentFor.get(key) ?? 0) + 1;
    absentFor.set(key, strikes);
    if (strikes < needed) continue;

    logger.info(
      `[Stops] ${key} is not held at the venue on ${strikes} consecutive reads — removing its `
        + `snapshot: ${JSON.stringify(snapshots[key])}`,
    );
    const ids = [snapshots[key].stopOrderId, snapshots[key].takeProfitOrderId].filter((id): id is string => !!id);
    const outcomes = await Promise.all(ids.map(id => broker.getOrder(id)));
    if (!outcomes.some(o => o?.status === 'filled')) continue;
    removePositionSnapshot(key);
    absentFor.delete(key);
  }

  // An id that names nothing open is cleared, whether or not the position is still held: the
  // stop having filled is one of the ways it stops existing.
  for (const p of positions) {
    const recorded = getPositionSnapshot(p.symbol)?.stopOrderId;
    if (!recorded || isStopLocked(p.symbol)) continue;
    if (!orders.some(o => o.id === recorded)) {
      patchPositionSnapshot(p.symbol, { stopOrderId: undefined });
      logger.warn(
        `[Stops] ${p.symbol} recorded stop order ${recorded}, which is no longer resting at the `
          + `venue — cleared. It filled, expired, or was cancelled outside this system.`,
      );
    }
  }

  // Symmetric to the stop-id clearing above, for the take-profit leg of an OCO pair.
  for (const p of positions) {
    const recorded = getPositionSnapshot(p.symbol)?.takeProfitOrderId;
    if (!recorded || isStopLocked(p.symbol)) continue;
    if (!orders.some(o => o.id === recorded)) {
      patchPositionSnapshot(p.symbol, { takeProfitOrderId: undefined });
      logger.warn(
        `[Stops] ${p.symbol} recorded take-profit order ${recorded}, which is no longer resting `
          + `at the venue — cleared. It filled, expired, or was cancelled outside this system.`,
      );
    }
  }

  for (const candidate of needsArming(positions, orders, getState().positionSnapshots)) {
    // Re-checked HERE, not only in the selection above: an exit or an entry can take the lock
    // during any of the awaits in this loop, and the selection is already stale by then.
    if (isStopLocked(candidate.symbol)) continue;

    const armed = await withStopLock(candidate.symbol, () =>
      armStop(candidate.symbol, candidate.qty, candidate.stopLevel));

    if (armed.ok) {
      patchPositionSnapshot(candidate.symbol, { stopOrderId: armed.orderId });
      lastFailure.delete(canonicalSymbol(candidate.symbol));
    } else {
      logFailureOnce(candidate.symbol, armed.reason);
    }
  }

  for (const action of needsOcoAction(positions, orders, getState().positionSnapshots)) {
    // Re-checked HERE for the same reason as the stop loop above.
    if (isStopLocked(action.symbol)) continue;

    const armed = await withStopLock(action.symbol, async () => {
      if (action.kind === 'repair') {
        return { ok: false as const, reason: 'One protective leg is missing. Inspect the broker orders before replacing the pair.' };
      }
      return armOco(action.symbol, action.qty, action.stopLevel, action.takeProfitLevel);
    });

    if (armed.ok) {
      patchPositionSnapshot(action.symbol, {
        stopOrderId: armed.stopOrderId,
        takeProfitOrderId: armed.takeProfitOrderId,
      });
      lastFailure.delete(canonicalSymbol(action.symbol));
    } else {
      logFailureOnce(action.symbol, armed.reason);
    }
  }
}

function guardedBroker() { assertExecutionOwner(); return broker; }

async function verifyFreeHolding(symbol: string, qty: number): Promise<void> {
  const held = (await broker.getPositions()).find(p => sameSymbol(p.symbol, symbol));
  if (!held || held.qty < qty || !Number.isInteger(qty)) throw new Error('Holding changed or quantity is unsupported');
  const sells = (await broker.getOpenOrders()).filter(o => sameSymbol(o.symbol, symbol) && o.side === 'sell');
  if (sells.length) throw new Error('Existing sell orders must be reviewed before adding protection');
}
