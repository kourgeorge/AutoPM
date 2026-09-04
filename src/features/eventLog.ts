/**
 * L2 — the event log.
 *
 * One JSON object per line in `data/events.jsonl`, appended synchronously. A photograph of
 * every `TriggerEvent` at the instant it fired, for browsing "what happened overnight" — it
 * is never read back to reconstruct ack state, and it never feeds `eventBus.ts`'s live
 * registry. That registry forgets acks on restart on purpose (see `eventBus.ts`); this log
 * remembers everything on purpose. The two intentionally disagree after a restart with a
 * still-breaching condition, and that disagreement is the point.
 *
 * Modeled directly on `src/journal/journal.ts`.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../core/logger';
import type { TriggerEvent } from './eventBus';
import { DATA_DIR, ensureDataDir } from '../core/paths';

export const EVENT_LOG_FILE = path.join(DATA_DIR, 'events.jsonl');

let _ephemeral = false;

/**
 * Stop writing to disk, permanently for this process. Replay seam, mirroring
 * `useEphemeralJournal`.
 */
export function useEphemeralEventLog(): void {
  _ephemeral = true;
}

/**
 * Append one event exactly as it exists at fire time. A write failure is logged and
 * swallowed — the log is a witness, not a participant, and a full disk must not turn a
 * real event into a thrown exception.
 */
export function appendEventLog(event: TriggerEvent): void {
  if (_ephemeral) return;
  try {
    ensureDataDir();
    fs.appendFileSync(EVENT_LOG_FILE, JSON.stringify(event) + '\n', 'utf8');
  } catch (err: any) {
    logger.error(`[EventLog] write failed for ${event.id}: ${err.message}`);
  }
}

/**
 * Read events back, oldest first.
 *
 * An unparseable line is SKIPPED rather than thrown on: a process killed mid-append leaves
 * a torn final line, and that must cost the last record, not the file.
 */
export function readEventLog(opts: { limit?: number } = {}): TriggerEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(EVENT_LOG_FILE, 'utf8');
  } catch {
    return [];
  }

  const events: TriggerEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line) as TriggerEvent);
    } catch {
      // torn or hand-edited line — skip it
    }
  }

  return opts.limit != null ? events.slice(-opts.limit) : events;
}
