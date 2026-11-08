import { agentContext } from './agentContext';
import { getState } from '../state/state';

/**
 * Pausing stops the trader acting on its own — scheduled reviews, its own orders, the trailing
 * stop. It does not stop the operator: an order the operator asked for (in chat to the
 * assistant, or relayed to the trader) still runs, under every other guard and approval rule.
 * Pausing to look at something and then being unable to fix it was the IBM target, 2026-11-08.
 *
 * `actorId` is who started the request behind the action; 'system' is the scheduler. Omitted,
 * it is read from the running tool call.
 */
export function blockedByPause(actorId: string | undefined = agentContext.getStore()?.actorId): boolean {
  return getState().paused && (actorId ?? 'system') === 'system';
}
