/** Choose automatic approval or human review for the shared durable action queue. */
import { config } from './config';
import { getPolicy } from '../policy/load';
import type { AutomationLevel, AutomationLevels, AutomationPolicy } from '../policy/types';
import type { ActionKind } from '../state/state';

const LEVEL_KEY: Record<ActionKind, keyof AutomationLevels> = {
  entry: 'entry',
  exit: 'exit',
  stop_adjust: 'stopAdjust',
  target_adjust: 'targetAdjust',
};

const ALL_KINDS: readonly ActionKind[] = ['entry', 'exit', 'stop_adjust', 'target_adjust'];

/**
 * Does this queued action need human approval?
 *
 * The level applies uniformly on paper and live — there is no venue-based exemption. The
 * `automation` argument is injectable for the replay harness and probes, and for no other
 * reason.
 */
export function automationLevel(
  action: ActionKind,
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
    return `automatic for all actions (venue ${venue})`;
  }
  return `armed on ${venue} for ${manual.join(', ')} — ${automation.timeoutMs / 60_000} min to decide, then ${automation.onTimeout}`;
}
