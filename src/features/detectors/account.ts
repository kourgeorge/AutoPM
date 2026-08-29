/**
 * Account-level risk: the daily loss halt.
 *
 * Two things watch this limit and they are NOT redundant. This detector is the ALARM: it
 * runs on the tick loop and wakes the trader. `enterPosition` holds the BRAKE: it refuses
 * the order. The alarm cannot stop an entry and the brake cannot tell anyone, so both
 * exist — but they must never disagree, which is why the arithmetic and the units now live
 * once, in `dailyLossStatus`, and both sites call it.
 *
 * (The header here used to say "nothing runs it on a clock — so the halt only happens if
 * the LLM happens to ask". That described the world before this file existed and read like
 * a live confession. The brake is on the order path, which every entry must pass; it needs
 * no clock.)
 */

import { dailyLossStatus } from '../../strategy/riskManager';
import type { Detector, DetectorHit } from '../eventBus';
import { pctText } from './util';

export const dailyLossDetector: Detector = {
  kind: 'daily_loss_breach',
  evaluate(data, policy) {
    const a = data.account;
    const status = dailyLossStatus(a.equity, a.startOfDayEquity, policy.risk.maxDailyLossPct);

    if (status.state === 'unmeasurable') {
      // `return []` used to be the whole answer here, and silence is indistinguishable from
      // a flat day. The one moment the operator most needs to hear from this detector is the
      // moment it cannot do its job.
      //
      // A stale account is a different story with its own detector, so don't tell it twice.
      if (a.stale) return [];

      return [
        {
          symbol: null,
          cooldownKey: 'daily_loss_unmeasurable',
          // `warn` reaches the operator (`alertsUser`) without waking a cycle
          // (`wakesTrader` covers urgent/critical only). Deliberate: `enterPosition` has
          // already refused every entry, so there is nothing for the trader to decide, and
          // waking it to say "the brake is on" costs more than it returns.
          severity: 'warn',
          headline:
            `Daily loss limit cannot be measured — ${status.reason}. `
            + 'Entries are blocked until the daily reset produces a baseline.',
          evidence: {
            startOfDayEquity: a.startOfDayEquity,
            equity: a.equity ?? 'n/a',
            reason: status.reason ?? 'unknown',
            positionCount: a.positionCount,
          },
          suggestedAction: 'review',
          // No `crossing` ON PURPOSE: this is a fact about the baseline, not a level to
          // recross, so `processHits` treats it as a cooldown-gated one-shot. The fixed
          // `cooldownKey` means it cannot grow `state.json` either.
        },
      ];
    }

    // Returned whether or not it is breached: the crossing gates own that decision, and
    // they need the un-breached readings to re-arm the latch and resolve a live event.
    const hit: DetectorHit = {
      symbol: null,
      cooldownKey: 'daily_loss_breach',
      severity: 'critical',
      headline: `Daily loss ${pctText(status.dayPnLPct)} against the ${Math.abs(status.thresholdPct).toFixed(2)}% limit — entries must halt for the day`,
      evidence: {
        dayPnLPct: status.dayPnLPct!,
        threshold: status.thresholdPct,
        startOfDayEquity: a.startOfDayEquity,
        equity: a.equity ?? 'n/a',
        positionCount: a.positionCount,
      },
      suggestedAction: 'review',
      // Day P&L is derived from one equity reading, so it inherits the same one-bad-number
      // risk as a price level — and this is the event that HALTS ENTRIES for the day.
      confirmTicks: policy.triggers.confirmTicks,
      crossing: {
        level: status.dayPnLPct!,
        threshold: status.thresholdPct,
        direction: 'below',
        band: policy.triggers.hysteresisPct,
      },
    };

    return [hit];
  },
};
