import crypto from 'crypto';
import { appendFeed, database, readRecord, readValue, saveRecord, saveValue, transaction } from './storage';
import { agentContext, assertAgentActive, recordToolEffect, type AgentRole } from './agentContext';
import { getState } from '../state/state';

export interface AgentCommand {
  id: string; role: AgentRole; actorId: string; accountId: string | null; text: string;
  parentId?: string; createdAt: string;
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted';
  result?: string; actionIds: string[];
}
export function getCommand(id: string): AgentCommand | undefined { return readRecord('command', id); }
export function listCommands(limit = 50): AgentCommand[] {
  return database().prepare('SELECT value FROM records WHERE kind=? ORDER BY seq DESC LIMIT ?').all('command', Math.min(100, limit)).map(r => JSON.parse(r.value));
}
export function pendingCommands(role: AgentRole): AgentCommand[] {
  return database().prepare("SELECT value FROM records WHERE kind='command' AND json_extract(value,'$.role')=? AND json_extract(value,'$.status') IN ('queued','running','interrupted') ORDER BY seq LIMIT 20")
    .all(role).map(r => JSON.parse(r.value));
}
export function enqueueCommand(role: AgentRole, text: string, actorId = 'operator', id?: string): AgentCommand {
  return transaction(() => {
    assertAgentActive();
    const parent = agentContext.getStore();
    id ??= parent?.attemptId ? 'handoff-' + parent.attemptId : crypto.randomUUID();
    const existing = getCommand(id);
    if (existing) return existing;
    if (!text.trim() || text.length > 4000) throw new Error('A message must contain 1–4000 characters');
    if (pendingCommands(role).length >= 20) throw new Error('Agent queue is full; wait for a pending request to finish');
    const command: AgentCommand = { id, role, actorId: parent?.actorId ?? actorId, parentId: parent?.commandId,
      accountId: getState().accountId, text, createdAt: new Date().toISOString(), status: 'queued', actionIds: [] };
    saveRecord('command', id, command);
    if (parent) recordToolEffect({ ok: true, receipt: { commandId: id, status: getState().paused ? 'queued_paused' : 'queued' } });
    return command;
  });
}
export function updateCommand(id: string, patch: Partial<Pick<AgentCommand, 'status' | 'result' | 'actionIds'>>): AgentCommand {
  return transaction(() => {
    const current = getCommand(id);
    if (!current) throw new Error('Unknown command');
    const next = { ...current, ...patch };
    saveRecord('command', id, next);
    if (patch.result && patch.result !== current.result) appendFeed({ at: new Date().toISOString(), kind: 'reply', text: `${next.role} request ${id}: ${patch.result}` });
    return next;
  });
}
export function linkCommandAction(commandId: string | undefined, actionId: string): void {
  if (!commandId) return;
  const command = getCommand(commandId);
  if (command && !command.actionIds.includes(actionId)) updateCommand(commandId, { actionIds: [...command.actionIds, actionId] });
}
export function migrateChatQueue(): void {
  if (readValue('import:chatCommands')) return;
  transaction(() => {
    for (const [i, text] of (readValue<string[]>('messageQueue') ?? []).entries()) enqueueCommand('concierge', text, 'legacy-operator', 'legacy-chat-' + i);
    saveValue('messageQueue', []); saveValue('import:chatCommands', true);
  });
}
