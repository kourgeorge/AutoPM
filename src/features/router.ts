/**
 * The live router — where the pipeline finally reaches the decision maker.
 *
 * Its whole job is COALESCING. The scheduler hands over every event that survived the
 * four gates, which on a busy tick is a dozen: `entry_signal` fires per watchlist symbol,
 * so the first bull open can produce fifteen at once. Delivering those one at a time is
 * what turns a working detector into a wake storm, so:
 *
 *  - ONE `wakeTrader()` per tick. Free, because the wake carries no payload — events are
 *    read from the registry at cycle start, so N wakes and 1 wake produce an identical cycle.
 *  - ONE `alertUser()` per tick, multi-line. Not free: `concierge.pushAlert` injects a
 *    synthetic user turn AND an assistant echo into its history, so N pushes cost 2N turns
 *    of context pollution for information that fits in one message.
 *
 * Severity policy lives in `wakesTrader` / `alertsUser` and is not duplicated here. A
 * router that re-decided which severities matter would be a second, divergent copy of the
 * routing table.
 *
 * Separate from scheduler.ts because that file's contract is "no opinion about waking
 * anyone" — it must not import the trader or the concierge.
 */

import { logger } from '../core/logger';
import { alertsUser, wakesTrader, type TriggerEvent } from './eventBus';
import type { EventRouter } from './scheduler';

export interface RouterDeps {
  /** Interrupt the trader's sleep. Called at most once per tick, with no message. */
  wakeTrader: () => void;
  /** Reach the human operator. Called at most once per tick, with a multi-line body. */
  alertUser: (message: string) => void;
}

/** Escalations at or above this wakeCount say so out loud. */
const ESCALATION_AT = 3;

/**
 * One line per event, with the escalation made explicit.
 *
 * `wakeCount` is otherwise invisible to the operator: the third report of an unacked
 * critical is worded identically to the first, so a breach nobody is handling reads as
 * routine repetition. Saying how many times the machine has asked is the difference
 * between noise and an alarm.
 */
function line(event: TriggerEvent): string {
  const escalated =
    event.wakeCount >= ESCALATION_AT
      ? `UNACTIONED x${event.wakeCount} — the machine has told the trader ${event.wakeCount} times and this is still open. `
      : '';
  return `[${event.severity.toUpperCase()}] ${escalated}${event.headline}`;
}

export function createLiveRouter(deps: RouterDeps): EventRouter {
  return (events) => {
    const waking = events.filter(wakesTrader);
    const alerting = events.filter(alertsUser);

    logger.info(
      `[Router] ${events.length} event(s) — ${waking.length} waking, ${alerting.length} alerting`,
    );

    if (alerting.length > 0) {
      deps.alertUser(alerting.map(line).join('\n'));
    }

    if (waking.length > 0) {
      logger.info(
        `[Router] waking trader — ${waking.map((e) => `${e.kind}${e.symbol ? ':' + e.symbol : ''}`).join(', ')}`,
      );
      deps.wakeTrader();
    }
  };
}
