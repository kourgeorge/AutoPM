import crypto from 'crypto';
import { appendActivity, listRecords, readRecord, saveRecord, transaction } from './storage';
import { agentContext, assertAgentActive, recordToolResult, type AgentRole } from './agentContext';
import { getState } from '../state/state';

export interface AgentRequest {
  id: string; role: AgentRole; actorId: string; text: string;
  parentId?: string; createdAt: string;
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted';
  result?: string; actionIds: string[];
}
export function getRequest(id: string): AgentRequest | undefined { return readRecord('requests', id); }
export function listRequests(limit = 50): AgentRequest[] {
  return listRecords<AgentRequest>('requests', { desc: true, limit: Math.min(100, limit) }).map(r => r.value);
}
export function pendingRequests(role: AgentRole): AgentRequest[] {
  return listRecords<AgentRequest>('requests', { where: c => c.role === role && ['queued','running','interrupted'].includes(c.status), limit: 20 })
    .map(r => r.value);
}
export function enqueueRequest(role: AgentRole, text: string, actorId = 'operator', id?: string): AgentRequest {
  return transaction(() => {
    assertAgentActive();
    const parent = agentContext.getStore();
    id ??= parent?.toolCallId ? 'handoff-' + parent.toolCallId : crypto.randomUUID();
    const existing = getRequest(id);
    if (existing) return existing;
    if (!text.trim() || text.length > 4000) throw new Error('A message must contain 1–4000 characters');
    if (pendingRequests(role).length >= 20) throw new Error('Agent queue is full; wait for a pending request to finish');
    const command: AgentRequest = { id, role, actorId: parent?.actorId ?? actorId, parentId: parent?.requestId,
      text, createdAt: new Date().toISOString(), status: 'queued', actionIds: [] };
    saveRecord('requests', id, command);
    if (parent) recordToolResult({ ok: true, receipt: { requestId: id, status: getState().paused ? 'queued_paused' : 'queued' } });
    return command;
  });
}
export function updateRequest(id: string, patch: Partial<Pick<AgentRequest, 'status' | 'result' | 'actionIds'>>): AgentRequest {
  return transaction(() => {
    const current = getRequest(id);
    if (!current) throw new Error('Unknown command');
    const next = { ...current, ...patch };
    saveRecord('requests', id, next);
    if (patch.result && patch.result !== current.result) appendActivity({ at: new Date().toISOString(), kind: 'reply', text: patch.result });
    return next;
  });
}
export function linkRequestAction(requestId: string | undefined, actionId: string): void {
  if (!requestId) return;
  const command = getRequest(requestId);
  if (command && !command.actionIds.includes(actionId)) updateRequest(requestId, { actionIds: [...command.actionIds, actionId] });
}
