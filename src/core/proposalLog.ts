import crypto from 'crypto';
import path from 'path';
import type { Proposal, ProposalStatus } from '../state/state';
import { DATA_DIR } from './paths';
import { appendRecord, readRecords, importJsonLines } from './storage';
export const PROPOSAL_LOG_FILE = path.join(DATA_DIR, 'proposals.jsonl');
interface ProposalLogEntry { at: string; transition: ProposalStatus | 'created'; proposal: Proposal }
let ephemeral = false;
export function useEphemeralProposalLog(): void { ephemeral = true; }
export function appendProposalLog(proposal: Proposal, transition: ProposalStatus | 'created'): void {
  if (ephemeral) return;
  importJsonLines('proposal', PROPOSAL_LOG_FILE);
  const entry = { at: new Date().toISOString(), transition, proposal };
  appendRecord('proposal', crypto.randomUUID(), entry.at, entry);
}
export function readProposalLog(opts: { limit?: number } = {}): ProposalLogEntry[] {
  if (ephemeral) return [];
  importJsonLines('proposal', PROPOSAL_LOG_FILE);
  return readRecords('proposal', opts.limit);
}
