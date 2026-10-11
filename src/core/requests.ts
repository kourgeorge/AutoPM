import crypto from 'crypto';
import { appendActivity, listRecords, readRecord, saveRecord, transaction } from './storage';
import { agentContext, assertAgentActive, recordToolResult, type AgentRole } from './agentContext';
import { getState } from '../state/state';

/** startup: the engine started. event: an urgent event or the heartbeat. message: a chat or agent message. operator: the /cycle command. */
export type WakeReason = 'startup' | 'event' | 'message' | 'operator';
export interface AgentRequest {
  id: string; role: AgentRole; actorId: string; text: string;
  parentId?: string; createdAt: string;
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted';
  result?: string; orderIds: string[];
  /** Trader cycles: every pending event the cycle was shown, including older ones it already saw. */
  eventIds?: string[];
  /** Trader cycles: what woke the trader for this cycle. */
  wokenBy?: WakeReason[];
  /** Old trader research tasks only; research now runs as `researcher` requests. */
  mode?: 'review_only';
  /** Research requests: the ticker as written, used to reuse a pending request for the same stock. */
  symbol?: string;
  /** Research requests: post the result to the chat when it finishes. */
  replyToChat?: boolean;
}
export interface RequestOptions { symbol?: string; replyToChat?: boolean }
export function getRequest(id: string): AgentRequest | undefined { return readRecord('requests', id); }
export function listRequests(limit = 50): AgentRequest[] {
  return listRecords<AgentRequest>('requests', { desc: true, limit: Math.min(100, limit) }).map(r => r.value);
}
export function pendingRequests(role: AgentRole): AgentRequest[] {
  return listRecords<AgentRequest>('requests', { where: c => c.role === role && ['queued','running','interrupted'].includes(c.status), limit: 20 })
    .map(r => r.value);
}
export function enqueueRequest(role: AgentRole, text: string, actorId = 'operator', id?: string, options: RequestOptions = {}): AgentRequest {
  return transaction(() => {
    assertAgentActive();
    const parent = agentContext.getStore();
    id ??= parent?.toolCallId ? 'handoff-' + parent.toolCallId : crypto.randomUUID();
    const existing = getRequest(id);
    if (existing) return existing;
    if (!text.trim() || text.length > 4000) throw new Error('A message must contain 1–4000 characters');
    if (pendingRequests(role).length >= 20) throw new Error('Agent queue is full; wait for a pending request to finish');
    const command: AgentRequest = { id, role, actorId: parent?.actorId ?? actorId, parentId: parent?.requestId,
      text, createdAt: new Date().toISOString(), status: 'queued', orderIds: [], ...options };
    saveRecord('requests', id, command);
    if (parent) recordToolResult({ ok: true, receipt: { requestId: id, status: getState().paused ? 'queued_paused' : 'queued' } });
    return command;
  });
}
const finishedListeners = new Set<(request: AgentRequest) => void>();
/** Told once, when a request first reaches completed or failed. */
export function onRequestFinished(listener: (request: AgentRequest) => void): () => void {
  finishedListeners.add(listener); return () => finishedListeners.delete(listener);
}
const FINISHED = ['completed', 'failed'];

export function updateRequest(id: string, patch: Partial<Pick<AgentRequest, 'status' | 'result' | 'orderIds' | 'replyToChat' | 'eventIds' | 'wokenBy'>>): AgentRequest {
  return transaction(() => {
    const current = getRequest(id);
    if (!current) throw new Error('Unknown command');
    const next = { ...current, ...patch };
    saveRecord('requests', id, next);
    // Only the assistant talks to the operator. A trader result is a log line, not a chat reply;
    // the assistant reads it back through get_requests when asked. Work asked for from chat is
    // the exception below: its finished result is the answer the operator is waiting for.
    if (patch.result && patch.result !== current.result) {
      const at = new Date().toISOString();
      if (current.role === 'assistant') appendActivity({ at, kind: 'reply', source: 'assistant', text: patch.result });
      else appendActivity({ at, kind: 'log', source: current.role, level: 'INFO', text: `[${current.role === 'researcher' ? 'Research' : 'Trader'}] ${patch.result}` });
    }
    if (FINISHED.includes(next.status) && !FINISHED.includes(current.status)) {
      // A finished child is news for its parent. The assistant's channel is the chat; a trader
      // parent is woken by an event (see `publishRequestFinished`).
      const parent = current.parentId ? getRequest(current.parentId) : undefined;
      if (current.role !== 'assistant' && (next.replyToChat || parent?.role === 'assistant')) {
        const what = current.role === 'researcher' ? `Research on ${current.symbol ?? 'the requested stock'}` : 'The trader request you sent';
        appendActivity({ at: new Date().toISOString(), kind: 'reply', source: current.role, text: `${what} ${next.status === 'failed' ? 'failed' : 'finished'}: ${next.result ?? 'no result recorded'}` });
      }
      for (const listener of finishedListeners) listener(next);
    }
    return next;
  });
}
export function linkRequestOrder(requestId: string | undefined, orderId: string): void {
  if (!requestId) return;
  const command = getRequest(requestId);
  if (command && !command.orderIds.includes(orderId)) updateRequest(requestId, { orderIds: [...command.orderIds, orderId] });
}
