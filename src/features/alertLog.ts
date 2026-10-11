import type { TriggerEvent } from './eventBus';
import { appendRecord, readRecords, saveRecord } from '../core/storage';
let ephemeral = false;
export function useEphemeralAlertLog(): void { ephemeral = true; }
/**
 * Health and all-clear reports still reach the trader and the dashboard while pending, but are
 * not logged: they were ~90% of the log. A cleared incident records `handling: 'resolved'` itself.
 */
const NOT_LOGGED = new Set(['heartbeat', 'data_stale', 'condition_resolved']);
export function appendAlertLog(event: TriggerEvent): void {
  if (ephemeral || NOT_LOGGED.has(event.kind)) return;
  appendRecord('alerts', event.id + ':' + event.wakeCount, event.firedAt, event);
}
/** Replace the logged copy, so event.jsonl shows how the alert was handled. */
export function recordAlertHandling(event: TriggerEvent): void {
  if (ephemeral || NOT_LOGGED.has(event.kind)) return;
  saveRecord('alerts', event.id + ':' + event.wakeCount, event);
}
/**
 * A command you gave (pause, adopt, confirm protection, …) is an event too. It is logged
 * only: it never enters the trader's pending list or wakes anyone.
 */
export function recordOperatorCommand(actorId: string, command: string, details: Record<string, unknown> = {}, symbol: string | null = null): void {
  if (ephemeral) return;
  const at = new Date().toISOString();
  const { getPolicy } = require('../policy/load') as typeof import('../policy/load');
  const event: TriggerEvent = {
    id: `operator_command:${symbol ?? '-'}:${at}`, kind: 'operator_command', severity: 'info', symbol, firedAt: at,
    headline: `${actorId} ran ${command}${symbol ? ' for ' + symbol : ''}`, evidence: JSON.parse(JSON.stringify({ command, ...details })),
    policyVersion: getPolicy().version, cooldownKey: 'operator_command', suggestedAction: null,
    handledBy: actorId, handling: 'resolved', ackedAt: at, ackDisposition: null, ackNote: null, wakeCount: 1,
  };
  appendRecord('alerts', event.id + ':1', at, event);
}
export function readAlertLog(opts: { limit?: number } = {}): TriggerEvent[] {
  if (ephemeral) return [];
  return readRecords('alerts', opts.limit);
}
