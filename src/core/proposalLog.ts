/**
 * L0 — the proposal audit log.
 *
 * One JSON object per line in `data/proposals.jsonl`, appended synchronously on every
 * transition (created/approved/rejected/expired/executed/failed). `state.json` holds only the
 * CURRENT status of each proposal; this is the history — same split as `eventBus.ts`'s live
 * registry vs. `events.jsonl`.
 *
 * Modeled directly on `src/features/eventLog.ts`.
 */

import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import type { Proposal, ProposalStatus } from '../state/state';
import { DATA_DIR, ensureDataDir } from './paths';

export const PROPOSAL_LOG_FILE = path.join(DATA_DIR, 'proposals.jsonl');

interface ProposalLogEntry {
  at: string;
  transition: ProposalStatus | 'created';
  proposal: Proposal;
}

let _ephemeral = false;

/** Stop writing to disk, permanently for this process. Replay seam, mirroring `useEphemeralEventLog`. */
export function useEphemeralProposalLog(): void {
  _ephemeral = true;
}

/**
 * Append one transition exactly as the proposal exists at that instant. A write failure is
 * logged and swallowed — the log is a witness, not a participant.
 */
export function appendProposalLog(proposal: Proposal, transition: ProposalStatus | 'created'): void {
  if (_ephemeral) return;
  try {
    ensureDataDir();
    const entry: ProposalLogEntry = { at: new Date().toISOString(), transition, proposal };
    fs.appendFileSync(PROPOSAL_LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err: any) {
    logger.error(`[ProposalLog] write failed for ${proposal.id}: ${err.message}`);
  }
}

/** Read the log back, oldest first. An unparseable line is skipped, not thrown on. */
export function readProposalLog(opts: { limit?: number } = {}): ProposalLogEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(PROPOSAL_LOG_FILE, 'utf8');
  } catch {
    return [];
  }

  const entries: ProposalLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      entries.push(JSON.parse(line) as ProposalLogEntry);
    } catch {
      // torn or hand-edited line — skip it
    }
  }

  return opts.limit != null ? entries.slice(-opts.limit) : entries;
}
