import crypto from 'crypto';
import { notifyAccount } from '../core/notifications';
import { readValue, saveValue, transaction, appendRecord } from '../core/storage';
import { canonicalSymbol, sameSymbol } from '../core/symbols';
import { getState, patchPositionSnapshot, updateState } from '../state/state';
import { broker } from '../broker';
import { assertExecutionOwner } from '../core/runtime';
import { getOpenActions, transitionAction } from '../core/actions';

interface ProtectionIntent {
  id: string; symbol: string; at: string; stop: number; target?: number;
  status: 'pending' | 'confirmed' | 'unknown'; error?: string;
}
export function protectionIntents(): Record<string, ProtectionIntent> {
  return readValue('protectionIntents') ?? {};
}
function save(intent: ProtectionIntent): void {
  transaction(() => {
    saveValue('protectionIntents', { ...protectionIntents(), [canonicalSymbol(intent.symbol)]: intent });
    appendRecord('stop-requests', crypto.randomUUID(), new Date().toISOString(), intent);
  });
}

/** A request is durable before transmission. Uncertain protection is never blindly retried. */
export async function protect<T>(symbol: string, stop: number, target: number | undefined, send: (id: string) => Promise<T>): Promise<T> {
  const old = protectionIntents()[canonicalSymbol(symbol)];
  if (old && old.status !== 'confirmed') throw new Error('Protection outcome needs operator review: ' + old.id);
  assertExecutionOwner();
  const intent: ProtectionIntent = { id: 'atp-' + crypto.randomBytes(12).toString('hex'), symbol,
    at: new Date().toISOString(), stop, target, status: 'pending' };
  save(intent);
  try {
    const result = await send(intent.id);
    save({ ...intent, status: 'confirmed' });
    return result;
  } catch (err: any) {
    save({ ...intent, status: 'unknown', error: err.message });
    updateState({ paused: true });
    notifyAccount('protection_unknown', `${symbol}: protection needs review. Trading is paused.`);
    throw err;
  }
}

/**
 * A protective order this system placed minutes ago is missing from the broker's open orders.
 *
 * That is not "it filled or someone cancelled it" — it is the signature of an order the venue
 * never really accepted, and clearing and re-placing it is a loop (one new order per sweep).
 * Marking the request unknown stops the sweep re-arming this symbol and pauses trading until
 * the operator has looked at the broker.
 */
export const VANISHED_WINDOW_MS = 10 * 60_000;
export function recentlyConfirmedIntent(symbol: string, now = Date.now()): ProtectionIntent | undefined {
  const intent = protectionIntents()[canonicalSymbol(symbol)];
  return intent?.status === 'confirmed' && now - Date.parse(intent.at) < VANISHED_WINDOW_MS ? intent : undefined;
}
export function flagVanishedProtection(symbol: string, orderId: string): void {
  const intent = protectionIntents()[canonicalSymbol(symbol)];
  if (!intent) return;
  save({ ...intent, status: 'unknown', error: `order ${orderId} disappeared from the broker within minutes of being placed` });
  updateState({ paused: true });
  notifyAccount('protection_unknown', `${symbol}: protective order ${orderId} vanished right after it was placed. Trading is paused; check the broker's orders before resuming.`);
}

/**
 * The operator has checked the broker and the uncertain request never became an order: clear
 * it so the sweep may place protection again. Refused while the broker shows ANY order for the
 * symbol — that case is a relink (`confirmProtection`) or a manual cleanup, never a re-arm,
 * because re-arming next to a live order is exactly the duplicate this guard exists to stop.
 */
export async function clearUnplacedProtection(symbol: string, actorId: string): Promise<void> {
  const key = canonicalSymbol(symbol);
  const intent = protectionIntents()[key];
  if (!intent || intent.status === 'confirmed') throw new Error(`No uncertain protection request for ${key}`);
  if ((await broker.getOpenOrders()).some(o => sameSymbol(o.symbol, key))) throw new Error(`The broker shows open orders for ${key}; cancel or review them first`);
  assertExecutionOwner();
  transaction(() => {
    const { [key]: _dropped, ...rest } = protectionIntents();
    saveValue('protectionIntents', rest);
    if (getState().positionSnapshots[key]) patchPositionSnapshot(key, { stopOrderId: undefined, takeProfitOrderId: undefined });
    appendRecord('stop-requests', crypto.randomUUID(), new Date().toISOString(), { ...intent, status: 'cleared', clearedBy: actorId });
    appendRecord('operator-commands', crypto.randomUUID(), new Date().toISOString(), { action: 'rearm', symbol: key, actorId, intentId: intent.id });
  });
}

/** A human can relink a confirmed broker stop after reviewing an interrupted request. */
export async function confirmProtection(symbol: string, stopId: string, targetId: string | undefined, actorId: string): Promise<void> {
  const adjustment = getOpenActions().find(p => p.status === 'unknown' && ['stop_adjust','target_adjust'].includes(p.kind) && sameSymbol(p.symbol, symbol));
  const intent = protectionIntents()[canonicalSymbol(symbol)] ?? (adjustment ? {
    id: adjustment.id, symbol, at: new Date(adjustment.createdAt).toISOString(),
    stop: Number(adjustment.params.stopLoss), target: getState().positionSnapshots[canonicalSymbol(symbol)]?.takeProfitLevel,
    status: 'unknown' as const,
  } : undefined);
  if (!intent || intent.status === 'confirmed') throw new Error('No interrupted protection request for this symbol');
  const positions = await broker.getPositions();
  const pos = positions.find(p => sameSymbol(p.symbol, symbol) && p.qty > 0);
  if (!pos || !getState().positionSnapshots[canonicalSymbol(symbol)]) throw new Error('Managed holding is unavailable');
  const orders = await broker.getOpenOrders();
  const stop = orders.find(o => o.id === stopId && sameSymbol(o.symbol, symbol) && o.side === 'sell' && o.type === 'stop');
  const target = orders.find(o => o.id === targetId && sameSymbol(o.symbol, symbol) && o.side === 'sell' && o.type === 'limit');
  if (!stop || stop.stopPrice !== intent.stop || stop.qty - stop.filled !== pos.qty) throw new Error('Broker stop does not match the intended price and held quantity');
  if (intent.target != null && (!target || target.limitPrice !== intent.target || target.qty - target.filled !== pos.qty)) throw new Error('Broker target does not match the intended price and held quantity');
  if (target && (!stop.groupId || stop.groupId !== target.groupId)) throw new Error('Stop and target must be a linked broker pair');
  assertExecutionOwner();
  transaction(() => {
    patchPositionSnapshot(symbol, { stopOrderId: stop.id, takeProfitOrderId: target?.id, stopLevel: intent.stop, takeProfitLevel: intent.target });
    save({ ...intent, status: 'confirmed', error: undefined });
    if (adjustment && Number(adjustment.params.stopLoss) === intent.stop) transitionAction(adjustment.id, 'executed', { actorId, result: {} });
    appendRecord('operator-commands', crypto.randomUUID(), new Date().toISOString(), { action: 'confirm_protection', symbol, actorId, stopId, targetId });
  });
}
