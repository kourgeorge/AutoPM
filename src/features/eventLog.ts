import path from 'path';
import type { TriggerEvent } from './eventBus';
import { DATA_DIR } from '../core/paths';
import { appendRecord, readRecords, importJsonLines } from '../core/storage';
export const EVENT_LOG_FILE = path.join(DATA_DIR, 'events.jsonl');
let ephemeral = false;
export function useEphemeralEventLog(): void { ephemeral = true; }
export function appendEventLog(event: TriggerEvent): void {
  if (ephemeral) return;
  importJsonLines('event', EVENT_LOG_FILE);
  appendRecord('event', event.id + ':' + event.wakeCount, event.firedAt, event);
}
export function readEventLog(opts: { limit?: number } = {}): TriggerEvent[] {
  if (ephemeral) return [];
  importJsonLines('event', EVENT_LOG_FILE);
  return readRecords('event', opts.limit);
}
