import crypto from 'crypto';
import { notifyAccount } from './notifications';
import { sameSymbol, canonicalSymbol } from './symbols';
import { getState, updateState, type Proposal, type ProposalKind, type ProposalStatus } from '../state/state';
import { getPolicyHash } from '../policy/load';
import { appendProposalLog } from './proposalLog';
import { database, readRecord, saveRecord, transaction } from './storage';
import { agentContext, assertAgentActive, recordToolEffect } from './agentContext';
import { getCommand, linkCommandAction, updateCommand } from './commands';
import { decision, recordDecision, recordDecisionOutcome, readDecision } from '../journal/journal';

const OPEN: ProposalStatus[] = ['pending', 'approved', 'executing', 'submitted', 'partial', 'unknown'];
const NEXT: Record<ProposalStatus, ProposalStatus[]> = {
  pending: ['approved', 'rejected', 'expired'],
  approved: ['executing', 'expired', 'failed'],
  executing: ['submitted', 'partial', 'executed', 'unknown', 'failed'],
  submitted: ['partial', 'executed', 'unknown', 'failed'],
  partial: ['partial', 'executed', 'unknown', 'failed'],
  unknown: ['submitted', 'partial', 'executed', 'failed'],
  rejected: [], expired: [], executed: [], failed: [],
};
export function getProposal(id: string): Proposal | undefined { return getState().proposals[id] ?? readRecord<Proposal>('action', id); }
export function getAllProposals(): Proposal[] { return Object.values(getState().proposals); }
export function getOpenProposals(): Proposal[] { return getAllProposals().filter(p => OPEN.includes(p.status)); }

export interface CreateProposalInput {
  kind: ProposalKind; symbol: string; venue: 'paper' | 'live'; params: Record<string, unknown>;
  reason: string; eventId?: string | null; timeoutMs: number; automatic?: boolean;
}
export function createProposal(input: CreateProposalInput): Proposal {
  return transaction(() => {
    assertAgentActive();
    const context = agentContext.getStore();
    const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, stable(v[k])])) : v;
    const intent = (p: typeof input | Proposal) => JSON.stringify(stable({ kind: p.kind, symbol: canonicalSymbol(p.symbol), venue: p.venue, params: p.params, reason: p.reason, eventId: p.eventId ?? null }));
    const key = context ? crypto.createHash('sha256').update(context.commandId + intent(input)).digest('hex') : undefined;
    const receipt = (p: Proposal) => {
      linkCommandAction(context?.commandId, p.id);
      recordToolEffect({ ok: true, pending: OPEN.includes(p.status), proposalId: p.id, status: p.status, params: p.params, automatic: p.automatic });
      return p;
    };
    const previousId = key ? readRecord<string>('actionIntent', key) : undefined;
    if (previousId) return receipt(getProposal(previousId)!);
    const duplicate = getOpenProposals().find(p => p.kind === input.kind && sameSymbol(p.symbol, input.symbol));
    if (duplicate) {
      if (intent(duplicate) !== intent(input)) throw new Error(`Conflicting open action ${duplicate.id}: ${JSON.stringify(duplicate.params)}. Review it before requesting different parameters.`);
      if (key) saveRecord('actionIntent', key, duplicate.id);
      return receipt(duplicate);
    }
    const now = Date.now();
    const id = crypto.randomBytes(12).toString('hex');
    const proposal: Proposal = {
      id, kind: input.kind, symbol: canonicalSymbol(input.symbol), venue: input.venue,
      accountId: getState().accountId ?? undefined, policyHash: getPolicyHash(), clientOrderId: 'at-' + id,
      automatic: input.automatic ?? false, params: input.params, reason: input.reason,
      commandId: context?.commandId, requestedBy: context?.actorId, attemptId: context?.attemptId,
      eventId: input.eventId ?? null, createdAt: now, expiresAt: now + input.timeoutMs,
      status: input.automatic ? 'approved' : 'pending', decidedBy: null, decidedAt: input.automatic ? now : null,
      rejectReason: null, result: null,
    };
    updateState({ proposals: { ...getState().proposals, [id]: proposal } });
    saveRecord('action', id, proposal);
    ensureProposalDecision(proposal);
    if (key) saveRecord('actionIntent', key, id);
    appendProposalLog(proposal, 'created');
    if (!proposal.automatic) notifyAccount('approval_required', `${proposal.kind} ${proposal.symbol}: ${proposal.reason}`, proposal.id);
    return receipt(proposal);
  });
}
export function ensureProposalDecision(proposal: Proposal): void {
  if (readDecision('action-' + proposal.id)) return;
  const signal = proposal.params.signal as Record<string, number> | undefined;
  recordDecision(decision(proposal.kind === 'entry' || proposal.kind === 'exit' ? proposal.kind : 'adjustment', 'trader', {
    symbol: proposal.symbol, rationale: proposal.reason, proposalId: proposal.id, commandId: proposal.commandId, actorId: proposal.requestedBy,
    triggerEventId: proposal.eventId, orderStatus: proposal.status, requestedQty: Number(proposal.params.qty ?? 0) || null,
    filledQty: 0, qty: 0, intendedStop: signal?.stopLoss ?? proposal.params.stopLoss as number ?? null,
    intendedTarget: signal?.takeProfit ?? proposal.params.takeProfit as number ?? null,
    atrAtEntry: signal?.atr ?? null, protectionStatus: proposal.kind === 'exit' ? undefined : 'pending',
  }), 'action-' + proposal.id);
}
export function refreshCommandOutcome(commandId: string): void {
  const command = getCommand(commandId);
  if (!command || !command.actionIds.length) return;
  const actions = command.actionIds.map(id => getProposal(id)).filter((p): p is Proposal => !!p);
  const unfinished = actions.some(p => OPEN.includes(p.status));
  updateCommand(command.id, { ...(command.status !== 'running' ? { status: unfinished ? 'waiting' : actions.some(p => p.status !== 'executed') ? 'failed' : 'completed' } : {}),
    result: actions.map(p => `${p.kind} ${p.symbol}: ${p.status}${p.result?.filledQty != null ? ` (${p.result.filledQty}/${p.result.qty} filled)` : ''}${p.result?.error ? ' — ' + p.result.error : ''}`).join('; ') });
}
export interface TransitionMeta {
  decidedBy?: 'human' | 'timeout'; actorId?: string; rejectReason?: string;
  result?: NonNullable<Proposal['result']>; decisionId?: string;
}
export function transitionProposal(id: string, status: ProposalStatus, meta: TransitionMeta = {}): Proposal {
  return transaction(() => {
    const p = getProposal(id);
    if (!p) throw new Error('no such proposal: ' + id);
    if (!NEXT[p.status].includes(status)) throw new Error(`Proposal ${id} is already ${p.status}; cannot change to ${status}`);
    const next: Proposal = { ...p, ...meta, status,
      decidedAt: ['approved','rejected','expired'].includes(status) ? Date.now() : p.decidedAt };
    updateState({ proposals: { ...getState().proposals, [id]: next } });
    saveRecord('action', id, next);
    ensureProposalDecision(p);
    recordDecisionOutcome('action-' + id, { orderStatus: status });
    if (status === 'unknown') { updateState({ paused: true }); notifyAccount('broker_outcome_unknown', `${p.kind} ${p.symbol}: ${meta.result?.error ?? 'Broker outcome needs review'}`, p.id); }
    appendProposalLog(next, status);
    for (const row of database().prepare("SELECT id FROM records WHERE kind='command' AND EXISTS (SELECT 1 FROM json_each(json_extract(records.value,'$.actionIds')) WHERE value=?)").all(id)) refreshCommandOutcome(row.id);
    if (!OPEN.includes(status)) {
      const all = getAllProposals();
      const recent = all.filter(p => !OPEN.includes(p.status)).sort((a,b) => b.createdAt - a.createdAt).slice(0,500);
      updateState({ proposals: Object.fromEntries([...all.filter(p => OPEN.includes(p.status)), ...recent].map(p => [p.id,p])) });
    }
    return next;
  });
}
export function decideProposal(id: string, decision: 'approve' | 'reject', decidedBy: 'human' | 'timeout', rejectReason?: string, actorId = 'operator'): Proposal {
  const current = getProposal(id);
  if (!current) throw new Error('no such proposal: ' + id);
  if (current.status === (decision === 'approve' ? 'approved' : 'rejected')) return current;
  if (current.status === 'pending' && Date.now() >= current.expiresAt) {
    transitionProposal(id, 'expired', { decidedBy: 'timeout' });
    throw new Error('Proposal expired; request a fresh proposal');
  }
  if (decision === 'approve' && current.policyHash !== getPolicyHash()) throw new Error('Strategy changed; request a fresh proposal');
  return transitionProposal(id, decision === 'approve' ? 'approved' : 'rejected', { decidedBy, rejectReason, actorId });
}
