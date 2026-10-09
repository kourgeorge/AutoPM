import { AsyncLocalStorage } from 'async_hooks';
import { readRecord, saveRecord } from './storage';

export type AgentRole = 'trader' | 'assistant' | 'researcher';
export interface AgentContext {
  role: AgentRole;
  requestId: string;
  actorId: string;
  toolCallId?: string;
  signal?: AbortSignal;
}
export const agentContext = new AsyncLocalStorage<AgentContext>();
export function assertAgentActive(): void { agentContext.getStore()?.signal?.throwIfAborted(); }
/** Call inside the same transaction as a local mutation, before returning its receipt. */
export function recordToolResult(result: unknown): void {
  const id = agentContext.getStore()?.toolCallId;
  if (id) saveRecord('tool-calls', id, { ...readRecord<object>('tool-calls', id), result: JSON.stringify(result) });
}
