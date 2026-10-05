import crypto from 'crypto';
import { notifyAccount } from '../core/notifications';
import { readValue, saveValue, transaction, appendRecord } from '../core/storage';
import { canonicalSymbol, sameSymbol } from '../core/symbols';
import { getState, patchPositionSnapshot, updateState } from '../state/state';
import { broker } from '../broker';
import { assertExecutionOwner } from '../core/runtime';
import { getOpenProposals, transitionProposal } from '../core/proposals';

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
    appendRecord('protection', crypto.randomUUID(), new Date().toISOString(), intent);
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

/** A human can relink a confirmed broker stop after reviewing an interrupted request. */
export async function confirmProtection(symbol: string, stopId: string, targetId: string | undefined, actorId: string): Promise<void> {
  const adjustment = getOpenProposals().find(p => p.status === 'unknown' && ['stop_adjust','target_adjust'].includes(p.kind) && sameSymbol(p.symbol, symbol));
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
    if (adjustment && Number(adjustment.params.stopLoss) === intent.stop) transitionProposal(adjustment.id, 'executed', { actorId, result: {} });
    appendRecord('operator', crypto.randomUUID(), new Date().toISOString(), { action: 'confirm_protection', symbol, actorId, stopId, targetId });
  });
}
