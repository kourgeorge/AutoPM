/**
 * The automation gate — the pure policy question behind every proposal.
 *
 * Replaces `core/approvals.ts`. That module blocked a call until an operator answered, over a
 * registered channel `daemon.ts` had to wire up. This one does neither: it only answers
 * "auto or manual?" for a given action kind. The caller decides what to do with the
 * answer — act immediately on `auto`, or call `core/proposals.ts`'s `createProposal` on
 * `manual` and return without blocking. Nothing here touches state, a channel, or a promise.
 *
 * `ProposalKind` (snake_case: `stop_adjust`/`target_adjust`, `state/state.ts`) and
 * `AutomationLevels` (camelCase: `stopAdjust`/`targetAdjust`, `policy/types.ts`) name the same
 * four actions differently — one mirrors the tool-call vocabulary, the other mirrors the YAML
 * a human edits. `LEVEL_KEY` is the one place that bridges them.
 */

import { config } from './config';
import { getPolicy } from '../policy/load';
import type { AutomationLevel, AutomationLevels, AutomationPolicy } from '../policy/types';
import type { ProposalKind } from '../state/state';

const LEVEL_KEY: Record<ProposalKind, keyof AutomationLevels> = {
  entry: 'entry',
  exit: 'exit',
  stop_adjust: 'stopAdjust',
  target_adjust: 'targetAdjust',
};

const ALL_KINDS: readonly ProposalKind[] = ['entry', 'exit', 'stop_adjust', 'target_adjust'];

/**
 * Does this action act immediately, or does it need a proposal a human decides?
 *
 * The level applies uniformly on paper and live — there is no venue-based exemption. The
 * `automation` argument is injectable for the replay harness and probes, and for no other
 * reason.
 */
export function automationLevel(
  action: ProposalKind,
  automation: AutomationPolicy = getPolicy().automation,
): AutomationLevel {
  return automation.level[LEVEL_KEY[action]];
}

/** One line for the log and the boot banner: what the gate is doing, in words. */
export function automationSummary(
  automation: AutomationPolicy = getPolicy().automation,
  venue: 'paper' | 'live' = config.venue,
): string {
  const manual = ALL_KINDS.filter((k) => automationLevel(k, automation) === 'manual');
  if (manual.length === 0) {
    return `disarmed (venue ${venue})`;
  }
  return `armed on ${venue} for ${manual.join(', ')} — ${automation.timeoutMs / 60_000} min to decide, then ${automation.onTimeout}`;
}
