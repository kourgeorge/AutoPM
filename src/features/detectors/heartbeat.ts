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
import { pctText } from './util';
import { describeGap, investmentGap } from '../../strategy/investment';

export const heartbeatDetector: Detector = {
  kind: 'heartbeat',
  evaluate(data, policy) {
    const a = data.account;
    const holding = a.positionCount > 0;
    const symbols = Object.keys(data.positions);

    // The trader sets no timer of its own, so while the market is open this beat is what
    // wakes it: every 15 minutes holding, hourly flat. Closed, nothing can move a position,
    // so the beat is context only — ungated it meant 96 unactionable cycles a night.
    const open = data.session === 'open';
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
      cooldownMs: (holding || underInvested) && open
        ? policy.triggers.heartbeatWithPositionsMs
        : policy.triggers.heartbeatFlatMs,
    };

    return [hit];
  },
};
