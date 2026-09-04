/**
 * L4 — the tick-driven executor for the trade proposal state machine.
 *
 * The only place a manual-path proposal is ever executed. `enterPosition`/`exitPosition`
 * (`orderManager.ts`) and `toolAnnotatePosition` (`tools/traderTools.ts`) create a proposal and
 * return `pending` immediately — none of them place an order, cancel protection, or move a
 * venue stop. This module, called from `FeatureScheduler`'s tick loop alongside `sweepStops()`,
 * is what turns a human's `approve <id>` into an actual action, and it does so on its own
 * schedule, independent of the trader's cycle.
 *
 * Re-validates from the proposal's RAW `params` rather than trusting anything cached at
 * creation time — the position, the account, or the market can all have moved in the minutes
 * a human took to decide. A proposal that no longer validates fails; it is never forced through.
 */

import { logger } from '../core/logger';
import { getPolicy } from '../policy/load';
import { getAllProposals, transitionProposal } from '../core/proposals';
import type { Proposal } from '../state/state';
import type { SignalResult } from '../core/types';
import { GuardRejection, validateEntry, actEntry, validateExit, actExit } from './orderManager';
import { validateAnnotation, actAnnotation, type AnnotateInput } from '../tools/traderTools';

/** Re-validate and act on one `approved` proposal. Never throws — every failure lands as `failed`. */
async function executeProposal(p: Proposal): Promise<void> {
  try {
    switch (p.kind) {
      case 'entry': {
        const { signal, qty } = p.params as { signal: SignalResult; qty: number };
        const validated = await validateEntry(signal, qty);
        const result = await actEntry(validated);
        transitionProposal(p.id, 'executed', { result: { orderId: result.orderId, qty: result.qty } });
        break;
      }
      case 'exit': {
        const { qty } = p.params as { qty: number | null };
        const validated = await validateExit(p.symbol, qty ?? undefined);
        const result = await actExit(p.symbol, p.reason, validated);
        transitionProposal(p.id, 'executed', { result: { orderId: result.orderId, qty: result.qty } });
        break;
      }
      case 'stop_adjust':
      case 'target_adjust': {
        // `params` is stored as `Record<string, unknown>` on `Proposal`, but `toolAnnotatePosition`
        // is the only writer for this kind and always stores exactly `AnnotateInput`'s shape — the
        // intermediate `unknown` is what TS needs to accept a cast it can't verify structurally.
        const validated = await validateAnnotation(p.params as unknown as AnnotateInput);
        if (!validated.ok) {
          const parsed = JSON.parse(validated.response);
          transitionProposal(p.id, 'failed', { result: { error: parsed.error ?? validated.response } });
          break;
        }
        const raw = await actAnnotation(validated);
        const parsed = JSON.parse(raw);
        if (parsed.error) {
          transitionProposal(p.id, 'failed', { result: { error: parsed.error } });
        } else {
          const orderId = parsed.venueOco?.stopOrderId ?? parsed.venueStop?.orderId ?? undefined;
          transitionProposal(p.id, 'executed', orderId ? { result: { orderId } } : {});
        }
        break;
      }
    }
  } catch (err: any) {
    // A `GuardRejection` here means the world moved between approval and this tick — the same
    // position no longer qualifies, buying power dried up, whatever. That is a `failed`
    // proposal, not a crashed sweep: A TICK NEVER THROWS OUT.
    const message = err instanceof GuardRejection ? err.message : (err?.message ?? String(err));
    transitionProposal(p.id, 'failed', { result: { error: message } });
    logger.warn(`[Proposals] ${p.id} (${p.kind} ${p.symbol}) failed to execute: ${message}`);
  }
}

/**
 * Expire or auto-approve anything past its deadline, then execute everything `approved`.
 *
 * Two passes, not one: `onTimeout: 'allow'` moves a `pending` proposal straight to `approved`,
 * and that proposal must be picked up in the SAME sweep — a human who never answers should not
 * wait an extra tick beyond the timeout they were already given.
 */
export async function sweepProposals(): Promise<void> {
  const now = Date.now();
  const { onTimeout } = getPolicy().automation;

  for (const p of getAllProposals()) {
    if (p.status !== 'pending' || now < p.expiresAt) continue;

    if (onTimeout === 'allow') {
      transitionProposal(p.id, 'approved', { decidedBy: 'timeout' });
    } else {
      transitionProposal(p.id, 'expired', { decidedBy: 'timeout' });
    }
  }

  // Re-read after the timeout pass above may have just approved some.
  for (const p of getAllProposals()) {
    if (p.status === 'approved') await executeProposal(p);
  }
}
