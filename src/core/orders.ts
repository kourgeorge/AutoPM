import crypto from 'crypto';
import { notifyAccount } from './notifications';
import { sameSymbol, canonicalSymbol } from './symbols';
import { updateState, type Order, type OrderKind, type OrderStatus } from '../state/state';
import { getPolicyHash } from '../policy/load';
import { listRecords, readRecord, saveRecord, transaction } from './storage';
import { agentContext, assertAgentActive, recordToolResult } from './agentContext';
import { linkRequestOrder } from './requests';
import { decision, recordDecision, recordDecisionOutcome, readDecision } from '../journal/journal';
import { playDing } from './sound';

const OPEN: OrderStatus[] = ['pending', 'approved', 'executing', 'submitted', 'partial', 'unknown'];
const NEXT: Record<OrderStatus, OrderStatus[]> = {
  pending: ['approved', 'rejected', 'expired'],
  approved: ['executing', 'expired', 'failed'],
  executing: ['submitted', 'partial', 'executed', 'unknown', 'failed'],
  submitted: ['partial', 'executed', 'unknown', 'failed'],
  partial: ['partial', 'executed', 'unknown', 'failed'],
  unknown: ['submitted', 'partial', 'executed', 'failed'],
  rejected: [], expired: [], executed: [], failed: [],
};
/** orders.jsonl is the one copy of every action, open or finished. */
export function getOrder(id: string): Order | undefined { return readRecord<Order>('orders', id); }
export function listOrders(): Order[] { return listRecords<Order>('orders').map(r => r.value); }
export function pendingOrders(): Order[] { return listOrders().filter(p => OPEN.includes(p.status)); }

export interface CreateOrderInput {
  kind: OrderKind; symbol: string; venue: 'paper' | 'live'; params: Record<string, unknown>;
  reason: string; eventId?: string | null; timeoutMs: number; automatic?: boolean;
}
export function createOrder(input: CreateOrderInput): Order {
  return transaction(() => {
    assertAgentActive();
    const context = agentContext.getStore();
    const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, stable(v[k])])) : v;
    const intent = (p: typeof input | Order) => JSON.stringify(stable({ kind: p.kind, symbol: canonicalSymbol(p.symbol), venue: p.venue, params: p.params, reason: p.reason, eventId: p.eventId ?? null }));
    const key = context ? crypto.createHash('sha256').update(context.requestId + intent(input)).digest('hex') : undefined;
    const receipt = (p: Order) => {
      linkRequestOrder(context?.requestId, p.id);
      recordToolResult({ ok: true, pending: OPEN.includes(p.status), orderId: p.id, status: p.status, params: p.params, automatic: p.automatic });
      return p;
    };
    const previous = key ? listOrders().find(p => p.dedupKeys?.includes(key)) : undefined;
    if (previous) return receipt(previous);
    const duplicate = pendingOrders().find(p => p.kind === input.kind && sameSymbol(p.symbol, input.symbol));
    if (duplicate) {
      if (intent(duplicate) !== intent(input)) throw new Error(`Conflicting open action ${duplicate.id}: ${JSON.stringify(duplicate.params)}. Review it before requesting different parameters.`);
      if (!key) return receipt(duplicate);
      const shared = { ...duplicate, dedupKeys: [...(duplicate.dedupKeys ?? []), key] };
      saveRecord('orders', shared.id, shared);
      return receipt(shared);
    }
    const now = Date.now();
    const id = crypto.randomBytes(12).toString('hex');
    const action: Order = {
      id, kind: input.kind, symbol: canonicalSymbol(input.symbol), venue: input.venue,
      policyHash: getPolicyHash(), clientOrderId: 'at-' + id,
      automatic: input.automatic ?? false, params: input.params, reason: input.reason,
      requestId: context?.requestId, requestedBy: context?.actorId, toolCallId: context?.toolCallId,
      eventId: input.eventId ?? null, createdAt: now, expiresAt: now + input.timeoutMs,
      status: input.automatic ? 'approved' : 'pending', decidedBy: null, decidedAt: input.automatic ? now : null,
      rejectReason: null, result: null,
      ...(key ? { dedupKeys: [key] } : {}), history: [{ at: new Date(now).toISOString(), transition: 'created' }],
    };
    saveRecord('orders', id, action);
    ensureOrderDecision(action);
    if (!action.automatic) notifyAccount('approval_required', `${action.kind} ${action.symbol}: ${action.reason}`, action.id);
    return receipt(action);
  });
}
export function ensureOrderDecision(action: Order): void {
  if (readDecision('order-' + action.id)) return;
  const signal = action.params.signal as import('./types').SignalResult | undefined;
  recordDecision(decision(action.kind === 'entry' || action.kind === 'exit' ? action.kind : 'adjustment', 'trader', {
    symbol: action.symbol, rationale: action.reason, orderId: action.id, requestId: action.requestId, actorId: action.requestedBy,
    triggerEventId: action.eventId, orderStatus: action.status, requestedQty: Number(action.params.qty ?? 0) || null,
    filledQty: 0, qty: 0, intendedPrice: signal?.price ?? action.params.price as number ?? null, intendedStop: signal?.stopLoss ?? action.params.stopLoss as number ?? null,
    intendedTarget: signal?.takeProfit ?? action.params.takeProfit as number ?? null,
    thesis: signal?.thesis, observationIds: signal?.observationIds ?? action.params.observationIds as string[] | undefined, contextVariant: signal?.contextVariant,
    atrAtEntry: signal?.atr ?? null, protectionStatus: action.kind === 'exit' ? undefined : 'pending',
  }), 'order-' + action.id);
}
export interface TransitionMeta {
  decidedBy?: 'human' | 'timeout'; actorId?: string; rejectReason?: string;
  result?: NonNullable<Order['result']>; decisionId?: string;
}
export function transitionOrder(id: string, status: OrderStatus, meta: TransitionMeta = {}): Order {
  const next = transaction(() => {
    const p = getOrder(id);
    if (!p) throw new Error('no such order: ' + id);
    if (!NEXT[p.status].includes(status)) throw new Error(`Order ${id} is already ${p.status}; cannot change to ${status}`);
    const next: Order = { ...p, ...meta, status,
      decidedAt: ['approved','rejected','expired'].includes(status) ? Date.now() : p.decidedAt,
      history: [...(p.history ?? []), { at: new Date().toISOString(), transition: status, ...meta }] };
    saveRecord('orders', id, next);
    ensureOrderDecision(p);
    recordDecisionOutcome('order-' + id, { orderStatus: status });
    if (status === 'unknown') { updateState({ paused: true }); notifyAccount('broker_outcome_unknown', `${p.kind} ${p.symbol}: ${meta.result?.error ?? 'Broker outcome needs review'}`, p.id); }
    return next;
  });
  // After the transaction commits, so a rolled-back fill never dings. `executed` is reached once.
  if (status === 'executed' && (next.kind === 'entry' || next.kind === 'exit')) playDing();
  return next;
}
export function decideOrder(id: string, decision: 'approve' | 'reject', decidedBy: 'human' | 'timeout', rejectReason?: string, actorId = 'operator'): Order {
  const current = getOrder(id);
  if (!current) throw new Error('no such order: ' + id);
  if (current.status === (decision === 'approve' ? 'approved' : 'rejected')) return current;
  if (current.status === 'pending' && Date.now() >= current.expiresAt) {
    transitionOrder(id, 'expired', { decidedBy: 'timeout' });
    throw new Error('Order expired; request a fresh action');
  }
  if (decision === 'approve' && current.policyHash !== getPolicyHash()) throw new Error('Strategy changed; request a fresh action');
  return transitionOrder(id, decision === 'approve' ? 'approved' : 'rejected', { decidedBy, rejectReason, actorId });
}
