/**
 * Tier-3 heartbeat — the periodic look that no threshold can replace.
 *
 * Pure event-driven monitoring misses drift that crosses nothing: a position bleeding 0.3%
 * an hour never trips a detector until it has already tripped the stop. So the LLM always
 * gets a scheduled look at the full snapshot.
 *
 * This is the only detector with NO crossing. It is a one-shot: the bus treats it as
 * cooldown-gated only, and the cadence travels with the hit because nothing outside this
 * file knows which policy field paces it.
 */

import type { Detector, DetectorHit } from '../eventBus';
import type { TickData } from '../compute';
import type { Policy } from '../../policy/types';
import { pctText } from './util';
import { describeGap, investmentGap } from '../../strategy/investment';

/**
 * How long the beat waits between periodic checks for this tick. Also read by the dashboard
 * to count down the trader's next check, so both show the same cadence.
 */
export function heartbeatCadenceMs(data: Pick<TickData, 'account' | 'session' | 'portfolio'>, policy: Policy): number {
  const open = data.session !== 'closed';
  const underInvested = open && !!investmentGap(policy, data.portfolio?.grossDeployedPct)?.belowTarget;
  return (data.account.positionCount > 0 || underInvested) && open
    ? policy.triggers.heartbeatWithPositionsMs
    : policy.triggers.heartbeatFlatMs;
}

export const heartbeatDetector: Detector = {
  kind: 'heartbeat',
  evaluate(data, policy) {
    const a = data.account;
    const holding = a.positionCount > 0;
    const symbols = Object.keys(data.positions);

    // The trader sets no timer of its own, so while orders can trade this beat is what wakes
    // it: every 15 minutes holding, hourly flat. That includes pre-market and after-hours,
    // where entries and exits go out as extended-hours limits. 20:00–04:00 nothing can trade,
    // so the beat is context only — ungated it meant 96 unactionable cycles a night.
    //
    // Clock-only like the session itself: a holiday reads as tradable here, and the order
    // guard (which asks the venue calendar) is what refuses.
    const open = data.session !== 'closed';
    // Below the profile's investment target there is work to do even with nothing held, so
    // the beat runs at the holding cadence. Flat used to mean hourly — the less it had
    // invested, the less often it looked for something to buy.
    const gap = investmentGap(policy, data.portfolio?.grossDeployedPct);
    const underInvested = open && !!gap?.belowTarget;

    const hit: DetectorHit = {
      symbol: null,
      // One key for both cadences: switching from flat to holding should tighten the beat,
      // not start a second independent one.
      cooldownKey: 'heartbeat',
      severity: open ? 'urgent' : 'info',
      headline: (holding
        ? `Periodic check — ${a.positionCount} position(s) open (${symbols.join(', ')}), day P&L ${pctText(a.dayPnLPct)}`
        : `Periodic check — flat, day P&L ${pctText(a.dayPnLPct)}`)
        + (underInvested ? ` — ${gap!.belowFloor ? 'UNDER-INVESTED' : 'below target'}: ${describeGap(gap!)}` : ''),
      evidence: {
        positionCount: a.positionCount,
        symbols: symbols.join(',') || 'none',
        dayPnLPct: a.dayPnLPct ?? 'n/a',
        equity: a.equity ?? 'n/a',
        session: data.session,
        ...(gap ? { investedPct: Number(gap.investedPct.toFixed(2)), targetInvestedPct: gap.targetPct ?? 'none', minInvestedPct: gap.floorPct ?? 'none' } : {}),
      },
      suggestedAction: 'review',
      // `heartbeatFlatMs` already means "the slow cadence"; outside market hours that is
      // what a holding heartbeat wants too, so the two regimes reuse the two existing keys.
      cooldownMs: heartbeatCadenceMs(data, policy),
    };

    return [hit];
  },
};
