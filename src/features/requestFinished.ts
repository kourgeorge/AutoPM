import { getRequest, type AgentRequest } from '../core/requests';
import { getPolicy } from '../policy/load';
import { publishDiscrete, type TriggerEvent } from './eventBus';

/**
 * A finished child request is an event for its parent's agent. Only the trader is woken by
 * events; a child of a chat request is reported in the chat instead (see `updateRequest`).
 * `updateRequest` calls this once per request, so it needs no dedup of its own. A discrete
 * event is delivered by its publisher, so the caller wakes the trader.
 */
export function publishRequestFinished(request: AgentRequest): TriggerEvent | null {
  const parent = request.parentId ? getRequest(request.parentId) : undefined;
  if (parent?.role !== 'trader') return null;
  const what = request.role === 'researcher' ? `Research on ${request.symbol ?? 'a stock'}` : `The ${request.role} request`;
  return publishDiscrete('request_finished', {
    symbol: request.symbol ?? null,
    cooldownKey: 'request_finished:' + request.id,
    severity: 'urgent',
    headline: `${what} you asked for ${request.status === 'failed' ? 'failed' : 'finished'} (request ${request.id})`,
    evidence: { requestId: request.id, role: request.role, status: request.status, result: request.result ?? '' },
    suggestedAction: 'review',
  }, getPolicy());
}
