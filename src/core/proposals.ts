/**
 * The trade proposal state machine.
 *
 * Created ONLY when `automationLevel(kind)` (`core/automation.ts`) says a human must
 * decide. When the level is `auto`, nothing here is touched — the caller validates and acts
 * in the same call, exactly as it always has. A proposal exists to hold an action open across
 * cycle and tick boundaries until a human types `approve <id>` or `reject <id>` at the
 * terminal (`ui/ui.ts`) — no LLM anywhere ever gets a tool that can decide one.
 *
 * Storage is `SystemState.proposals` (`state/state.ts`): current status only, durable across
 * restarts via that module's own debounce/atomic-write machinery. Every transition is also
 * appended to `data/proposals.jsonl` (`proposalLog.ts`) for history — same split as
 * `eventBus.ts`'s live registry vs. `events.jsonl`.
 */

import crypto from 'crypto';
import { logger } from './logger';
import { getState, updateState } from '../state/state';
import type { Proposal, ProposalKind, ProposalStatus } from '../state/state';
import { appendProposalLog } from './proposalLog';

/** Fixed transition table. Any other move is a bug, not a runtime condition — it throws. */
const ALLOWED_NEXT: Record<ProposalStatus, readonly ProposalStatus[]> = {
  pending: ['approved', 'rejected', 'expired'],
  approved: ['executed', 'failed'],
  rejected: [],
  expired: [],
  executed: [],
  failed: [],
};

function generateProposalId(): string {
  return crypto.randomBytes(4).toString('hex');
}

export function getProposal(id: string): Proposal | undefined {
  return getState().proposals[id];
}

/** Pending, or approved but not yet picked up by the executor. What a human still cares about. */
export function getOpenProposals(): Proposal[] {
  return Object.values(getState().proposals).filter(
    (p) => p.status === 'pending' || p.status === 'approved',
  );
}

export function getAllProposals(): Proposal[] {
  return Object.values(getState().proposals);
}

function putProposal(p: Proposal): void {
  updateState({ proposals: { ...getState().proposals, [p.id]: p } });
}

export interface CreateProposalInput {
  kind: ProposalKind;
  symbol: string;
  venue: 'paper' | 'live';
  params: Record<string, unknown>;
  reason: string;
  eventId?: string | null;
  timeoutMs: number;
}

/** Create a new `pending` proposal. Returns immediately — nothing here blocks or touches the venue. */
export function createProposal(input: CreateProposalInput): Proposal {
  const now = Date.now();
  const proposal: Proposal = {
    id: generateProposalId(),
    kind: input.kind,
    symbol: input.symbol,
    venue: input.venue,
    params: input.params,
    reason: input.reason,
    eventId: input.eventId ?? null,
    createdAt: now,
    expiresAt: now + input.timeoutMs,
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    rejectReason: null,
    result: null,
  };
  putProposal(proposal);
  appendProposalLog(proposal, 'created');
  logger.trade(
    `[Proposal] ${proposal.id} created — ${proposal.kind} ${proposal.symbol} (${proposal.reason})`,
  );
  return proposal;
}

export interface TransitionMeta {
  decidedBy?: 'human' | 'timeout';
  rejectReason?: string;
  result?: { orderId?: string; qty?: number; error?: string };
}

/** Move a proposal to `next`. Throws if the move is not in `ALLOWED_NEXT` for its current status. */
export function transitionProposal(id: string, next: ProposalStatus, meta: TransitionMeta = {}): Proposal {
  const current = getProposal(id);
  if (!current) throw new Error(`[Proposal] ${id}: no such proposal`);
  if (!ALLOWED_NEXT[current.status].includes(next)) {
    throw new Error(`[Proposal] ${id}: illegal transition ${current.status} → ${next}`);
  }

  const updated: Proposal = {
    ...current,
    status: next,
    decidedBy: meta.decidedBy ?? current.decidedBy,
    decidedAt: (next === 'approved' || next === 'rejected' || next === 'expired')
      ? Date.now()
      : current.decidedAt,
    rejectReason: meta.rejectReason ?? current.rejectReason,
    result: meta.result ?? current.result,
  };
  putProposal(updated);
  appendProposalLog(updated, next);
  logger.trade(`[Proposal] ${id} ${current.status} → ${next}`);
  return updated;
}

/**
 * The one place a human's decision lands. `ui/ui.ts` calls this directly against a raw
 * keystroke command — no promise, no channel, since creation and decision are fully decoupled
 * (the executor picks up `approved` on its own next tick).
 */
export function decideProposal(
  id: string,
  decision: 'approve' | 'reject',
  decidedBy: 'human' | 'timeout',
  rejectReason?: string,
): Proposal {
  return transitionProposal(id, decision === 'approve' ? 'approved' : 'rejected', {
    decidedBy,
    rejectReason,
  });
}
