/**
 * L5 — the decision journal.
 *
 * One JSON object per line in `data/journal.jsonl`, appended synchronously.
 *
 * The synchronous write is the point. `state.ts` debounces 5s and `knowledge.json`
 * debounced 3s, and for those that is right: they hold CURRENT STATE, where coalescing
 * repeated writes is a feature. This holds WHAT HAPPENED. A record still sitting in a
 * timer when the process dies is worthless precisely in the case it was written for, so
 * the order and its record land together or the log says why they did not.
 *
 * No rotation: one line is ~500 bytes and a busy day is a few dozen decisions — about a
 * megabyte a year. Rotation would be the more complex answer to a problem that does not
 * exist yet.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../core/logger';
import { getPolicy } from '../policy/load';
import type { DecisionInput, DecisionRecord } from './types';
import { canonicalSymbol } from '../core/symbols';
import { DATA_DIR, ensureDataDir } from '../core/paths';

export const JOURNAL_FILE = path.join(DATA_DIR, 'journal.jsonl');

let _ephemeral = false;

/**
 * Stop writing to disk, permanently for this process. Replay seam, mirroring
 * `useEphemeralState`.
 *
 * Not optional in the harness: a replay run exercises the real write sites, so without
 * this it appends synthetic entries and vetoes to the operator's real history — which is
 * exactly the trap `useEphemeralState` exists to close, one file over.
 */
export function useEphemeralJournal(): void {
  _ephemeral = true;
}

/**
 * Append one decision. Returns the stamped record so the caller can store its `id` —
 * `openPositionSnapshot({ entryDecisionId })` is the reason this returns rather than voids.
 *
 * A write failure is logged and swallowed. The journal is a witness, not a participant:
 * a full disk must not turn a filled order into a thrown exception the model reads as a
 * failed one.
 */
export function recordDecision(input: DecisionInput): DecisionRecord {
  const at = new Date().toISOString();
  const record: DecisionRecord = {
    ...input,
    id: `${input.kind}:${input.symbol ?? 'system'}:${at}`,
    at,
  };

  if (!_ephemeral) {
    try {
      ensureDataDir();
      fs.appendFileSync(JOURNAL_FILE, JSON.stringify(record) + '\n', 'utf8');
    } catch (err: any) {
      logger.error(`[Journal] write failed for ${record.id}: ${err.message}`);
    }
  }

  logger.info(`[Journal] ${record.kind} ${record.symbol ?? ''} — ${record.rationale}`.trim());
  return record;
}

/**
 * Read decisions back, oldest first.
 *
 * An unparseable line is SKIPPED rather than thrown on: a process killed mid-append
 * leaves a torn final line, and that must cost the last record, not the file.
 */
export function readDecisions(opts: { symbol?: string; limit?: number } = {}): DecisionRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(JOURNAL_FILE, 'utf8');
  } catch {
    return [];
  }

  const records: DecisionRecord[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line) as DecisionRecord);
    } catch {
      // torn or hand-edited line — skip it
    }
  }

  // Canonical, so a `BTC/USD` decision is found by a caller holding the venue's `BTCUSD`.
  const wanted = opts.symbol ? canonicalSymbol(opts.symbol) : null;
  const filtered = wanted
    ? records.filter((r) => r.symbol != null && canonicalSymbol(r.symbol) === wanted)
    : records;

  return opts.limit != null ? filtered.slice(-opts.limit) : filtered;
}

/**
 * A `DecisionInput` with every optional field nulled, so a call site names only what it
 * knows. Without this each of the six write sites would spell out twelve `null`s, and a
 * field added later would be a six-file edit.
 */
export function decision(
  kind: DecisionRecord['kind'],
  actor: DecisionRecord['actor'],
  fields: Partial<DecisionInput> & { rationale: string },
): DecisionInput {
  return {
    kind,
    actor,
    symbol: null,
    triggerEventId: null,
    executed: false,
    qty: null,
    price: null,
    intendedStop: null,
    intendedTarget: null,
    atrAtEntry: null,
    orderId: null,
    vetoRule: null,
    venueMessage: null,
    venueStopId: null,
    venueStopMissing: null,
    pnl: null,
    policyVersion: getPolicy().version,
    ...fields,
  };
}
