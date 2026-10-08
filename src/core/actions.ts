import crypto from 'crypto';
import { notifyAccount } from './notifications';
import { sameSymbol, canonicalSymbol } from './symbols';
import { updateState, type Action, type ActionKind, type ActionStatus } from '../state/state';
import { getPolicyHash } from '../policy/load';
import { appendActionHistory } from './actionHistory';
import { listRecords, readRecord, saveRecord, transaction } from './storage';
import { agentContext, assertAgentActive, recordToolResult } from './agentContext';
import { getRequest, linkRequestAction, updateRequest } from './requests';
import { decision, recordDecision, recordDecisionOutcome, readDecision } from '../journal/journal';
import { playDing } from './sound';

const OPEN: ActionStatus[] = ['pending', 'approved', 'executing', 'submitted', 'partial', 'unknown'];
const NEXT: Record<ActionStatus, ActionStatus[]> = {
  pending: ['approved', 'rejected', 'expired'],
  approved: ['executing', 'expired', 'failed'],
  executing: ['submitted', 'partial', 'executed', 'unknown', 'failed'],
  submitted: ['partial', 'executed', 'unknown', 'failed'],
  partial: ['partial', 'executed', 'unknown', 'failed'],
  unknown: ['submitted', 'partial', 'executed', 'failed'],
  rejected: [], expired: [], executed: [], failed: [],
};
/** action.jsonl is the one copy of every action, open or finished. */
export function getAction(id: string): Action | undefined { return readRecord<Action>('actions', id); }
export function getAllActions(): Action[] { return listRecords<Action>('actions').map(r => r.value); }
export function getOpenActions(): Action[] { return getAllActions().filter(p => OPEN.includes(p.status)); }

export interface CreateActionInput {
  kind: ActionKind; symbol: string; venue: 'paper' | 'live'; params: Record<string, unknown>;
  reason: string; eventId?: string | null; timeoutMs: number; automatic?: boolean;
}
export function createAction(input: CreateActionInput): Action {
  return transaction(() => {
    assertAgentActive();
    const context = agentContext.getStore();
    const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, stable(v[k])])) : v;
    const intent = (p: typeof input | Action) => JSON.stringify(stable({ kind: p.kind, symbol: canonicalSymbol(p.symbol), venue: p.venue, params: p.params, reason: p.reason, eventId: p.eventId ?? null }));
    const key = context ? crypto.createHash('sha256').update(context.requestId + intent(input)).digest('hex') : undefined;
    const receipt = (p: Action) => {
      linkRequestAction(context?.requestId, p.id);
      recordToolResult({ ok: true, pending: OPEN.includes(p.status), actionId: p.id, status: p.status, params: p.params, automatic: p.automatic });
      return p;
    };
    const previousId = key ? readRecord<string>('action-dedup', key) : undefined;
    if (previousId) return receipt(getAction(previousId)!);
    const duplicate = getOpenActions().find(p => p.kind === input.kind && sameSymbol(p.symbol, input.symbol));
    if (duplicate) {
      if (intent(duplicate) !== intent(input)) throw new Error(`Conflicting open action ${duplicate.id}: ${JSON.stringify(duplicate.params)}. Review it before requesting different parameters.`);
      if (key) saveRecord('action-dedup', key, duplicate.id);
      return receipt(duplicate);
    }
    const now = Date.now();
    const id = crypto.randomBytes(12).toString('hex');
    const action: Action = {
      id, kind: input.kind, symbol: canonicalSymbol(input.symbol), venue: input.venue,
      policyHash: getPolicyHash(), clientOrderId: 'at-' + id,
      automatic: input.automatic ?? false, params: input.params, reason: input.reason,
      requestId: context?.requestId, requestedBy: context?.actorId, toolCallId: context?.toolCallId,
      eventId: input.eventId ?? null, createdAt: now, expiresAt: now + input.timeoutMs,
      status: input.automatic ? 'approved' : 'pending', decidedBy: null, decidedAt: input.automatic ? now : null,
      rejectReason: null, result: null,
    };
    saveRecord('actions', id, action);
    ensureActionDecision(action);
    if (key) saveRecord('action-dedup', key, id);
    appendActionHistory(action, 'created');
    if (!action.automatic) notifyAccount('approval_required', `${action.kind} ${action.symbol}: ${action.reason}`, action.id);
    return receipt(action);
  });
}
export function ensureActionDecision(action: Action): void {
  if (readDecision('action-' + action.id)) return;
  const signal = action.params.signal as import('./types').SignalResult | undefined;
  recordDecision(decision(action.kind === 'entry' || action.kind === 'exit' ? action.kind : 'adjustment', 'trader', {
    symbol: action.symbol, rationale: action.reason, actionId: action.id, requestId: action.requestId, actorId: action.requestedBy,
    triggerEventId: action.eventId, orderStatus: action.status, requestedQty: Number(action.params.qty ?? 0) || null,
    filledQty: 0, qty: 0, intendedPrice: signal?.price ?? action.params.price as number ?? null, intendedStop: signal?.stopLoss ?? action.params.stopLoss as number ?? null,
    intendedTarget: signal?.takeProfit ?? action.params.takeProfit as number ?? null,
    thesis: signal?.thesis, observationIds: signal?.observationIds ?? action.params.observationIds as string[] | undefined, contextVariant: signal?.contextVariant,
    atrAtEntry: signal?.atr ?? null, protectionStatus: action.kind === 'exit' ? undefined : 'pending',
  }), 'action-' + action.id);
}
export function refreshRequestOutcome(requestId: string): void {
  const command = getRequest(requestId);
  if (!command || !command.actionIds.length) return;
  const actions = command.actionIds.map(id => getAction(id)).filter((p): p is Action => !!p);
  const unfinished = actions.some(p => OPEN.includes(p.status));
  updateRequest(command.id, { ...(command.status !== 'running' ? { status: unfinished ? 'waiting' : actions.some(p => p.status !== 'executed') ? 'failed' : 'completed' } : {}),
    result: actions.map(p => `${p.kind} ${p.symbol}: ${p.status}${p.result?.filledQty != null ? ` (${p.result.filledQty}/${p.result.qty} filled)` : ''}${p.result?.error ? ' — ' + p.result.error : ''}`).join('; ') });
}
export interface TransitionMeta {
  decidedBy?: 'human' | 'timeout'; actorId?: string; rejectReason?: string;
  result?: NonNullable<Action['result']>; decisionId?: string;
}
export function transitionAction(id: string, status: ActionStatus, meta: TransitionMeta = {}): Action {
  const next = transaction(() => {
    const p = getAction(id);
    if (!p) throw new Error('no such action: ' + id);
    if (!NEXT[p.status].includes(status)) throw new Error(`Action ${id} is already ${p.status}; cannot change to ${status}`);
    const next: Action = { ...p, ...meta, status,
      decidedAt: ['approved','rejected','expired'].includes(status) ? Date.now() : p.decidedAt };
    saveRecord('actions', id, next);
    ensureActionDecision(p);
    recordDecisionOutcome('action-' + id, { orderStatus: status });
    if (status === 'unknown') { updateState({ paused: true }); notifyAccount('broker_outcome_unknown', `${p.kind} ${p.symbol}: ${meta.result?.error ?? 'Broker outcome needs review'}`, p.id); }
    appendActionHistory(next, status);
    for (const row of listRecords<{ actionIds?: string[] }>('requests', { where: c => c.actionIds?.includes(id) ?? false })) refreshRequestOutcome(row.id);
    return next;
  });
  // After the transaction commits, so a rolled-back fill never dings. `executed` is reached once.
  if (status === 'executed' && (next.kind === 'entry' || next.kind === 'exit')) playDing();
  return next;
}
export function decideAction(id: string, decision: 'approve' | 'reject', decidedBy: 'human' | 'timeout', rejectReason?: string, actorId = 'operator'): Action {
  const current = getAction(id);
  if (!current) throw new Error('no such action: ' + id);
  if (current.status === (decision === 'approve' ? 'approved' : 'rejected')) return current;
  if (current.status === 'pending' && Date.now() >= current.expiresAt) {
    transitionAction(id, 'expired', { decidedBy: 'timeout' });
    throw new Error('Action expired; request a fresh action');
  }
  if (decision === 'approve' && current.policyHash !== getPolicyHash()) throw new Error('Strategy changed; request a fresh action');
  return transitionAction(id, decision === 'approve' ? 'approved' : 'rejected', { decidedBy, rejectReason, actorId });
}
