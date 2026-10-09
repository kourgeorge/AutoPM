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
export function readAlertLog(opts: { limit?: number } = {}): TriggerEvent[] {
  if (ephemeral) return [];
  return readRecords('alerts', opts.limit);
}
