import type { TriggerEvent } from './eventBus';
import { appendRecord, readRecords, saveRecord } from '../core/storage';
let ephemeral = false;
export function useEphemeralAlertLog(): void { ephemeral = true; }
export function appendAlertLog(event: TriggerEvent): void {
  if (ephemeral) return;
  appendRecord('alerts', event.id + ':' + event.wakeCount, event.firedAt, event);
}
/** Replace the logged copy, so event.jsonl shows how the alert was handled. */
export function recordAlertHandling(event: TriggerEvent): void {
  if (ephemeral) return;
  saveRecord('alerts', event.id + ':' + event.wakeCount, event);
}
export function readAlertLog(opts: { limit?: number } = {}): TriggerEvent[] {
  if (ephemeral) return [];
  return readRecords('alerts', opts.limit);
}
