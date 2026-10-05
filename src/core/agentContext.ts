import { AsyncLocalStorage } from 'async_hooks';
import { saveRecord } from './storage';

export type AgentRole = 'trader' | 'concierge';
export interface AgentContext {
  role: AgentRole;
  commandId: string;
  actorId: string;
  attemptId?: string;
  signal?: AbortSignal;
}
export const agentContext = new AsyncLocalStorage<AgentContext>();
export function assertAgentActive(): void { agentContext.getStore()?.signal?.throwIfAborted(); }
/** Call inside the same transaction as a local mutation, before returning its receipt. */
export function recordToolEffect(result: unknown): void {
  const id = agentContext.getStore()?.attemptId;
  if (id) saveRecord('toolEffect', id, JSON.stringify(result));
}
