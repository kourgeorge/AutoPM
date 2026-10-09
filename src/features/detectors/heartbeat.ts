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

    const hit: DetectorHit = {
      symbol: null,
      // One key for both cadences: switching from flat to holding should tighten the beat,
      // not start a second independent one.
      cooldownKey: 'heartbeat',
      severity: open ? 'urgent' : 'info',
      headline: holding
        ? `Periodic check — ${a.positionCount} position(s) open (${symbols.join(', ')}), day P&L ${pctText(a.dayPnLPct)}`
        : `Periodic check — flat, day P&L ${pctText(a.dayPnLPct)}`,
      evidence: {
        positionCount: a.positionCount,
        symbols: symbols.join(',') || 'none',
        dayPnLPct: a.dayPnLPct ?? 'n/a',
        equity: a.equity ?? 'n/a',
        session: data.session,
      },
      suggestedAction: 'review',
      // `heartbeatFlatMs` already means "the slow cadence"; outside market hours that is
      // what a holding heartbeat wants too, so the two regimes reuse the two existing keys.
      cooldownMs: holding && open
        ? policy.triggers.heartbeatWithPositionsMs
        : policy.triggers.heartbeatFlatMs,
    };

    return [hit];
  },
};
