/**
 * Price-versus-level detectors: the stop and the target.
 *
 * Both compare a spot price to an absolute price level, so both work in DOLLARS —
 * `bandOf` converts the policy's percentage hysteresis into that unit.
 *
 * Both also carry `confirmTicks`: the level is a live spot price, so one bad quote is one
 * false breach, and the stop is the single most expensive place in the system to be wrong
 * about a number — a spurious breach at half the real price suggests `exit` on a position
 * that never moved.
 *
 * A position with no `stopLevel` is skipped rather than treated as a breach. Absence of a
 * stop is an entry-time failure for L4 to prevent, not something to report as a crossing.
 */

import type { Detector, DetectorHit } from '../eventBus';
import { bandOf, pctText } from './util';

export const stopBreachDetector: Detector = {
  kind: 'stop_breach',
  evaluate(data, policy) {
    const hits: DetectorHit[] = [];

    for (const f of Object.values(data.positions)) {
      // A stale price must never look like a crash — that is `data_stale`'s job.
      if (f.price === null || f.stale || f.stopLevel === null) continue;

      hits.push({
        symbol: f.symbol,
        cooldownKey: `stop_breach:${f.symbol}`,
        severity: 'critical',
        headline: `${f.symbol} stop breach — ${f.price.toFixed(2)} <= stop ${f.stopLevel.toFixed(2)} (entry ${f.entryPrice.toFixed(2)}, ${pctText(f.pnlPct)})`,
        evidence: {
          price: f.price,
          stopLevel: f.stopLevel,
          entryPrice: f.entryPrice,
          pnlPct: f.pnlPct ?? 'n/a',
          heldForMs: f.heldForMs,
        },
        suggestedAction: 'exit',
        confirmTicks: policy.triggers.confirmTicks,
        crossing: {
          level: f.price,
          threshold: f.stopLevel,
          direction: 'below',
          band: bandOf(f.stopLevel, policy),
        },
      });
    }

    return hits;
  },
};

export const takeProfitDetector: Detector = {
  kind: 'take_profit',
  evaluate(data, policy) {
    const hits: DetectorHit[] = [];

    for (const f of Object.values(data.positions)) {
      if (f.price === null || f.stale || f.takeProfitLevel === null) continue;

      hits.push({
        symbol: f.symbol,
        // `urgent`, not `critical`: a target reached is an opportunity to decide, and
        // escalating it would compete for attention with actual losses.
        severity: 'urgent',
        cooldownKey: `take_profit:${f.symbol}`,
        headline: `${f.symbol} target reached — ${f.price.toFixed(2)} >= target ${f.takeProfitLevel.toFixed(2)} (entry ${f.entryPrice.toFixed(2)}, ${pctText(f.pnlPct)})`,
        evidence: {
          price: f.price,
          takeProfitLevel: f.takeProfitLevel,
          entryPrice: f.entryPrice,
          pnlPct: f.pnlPct ?? 'n/a',
          heldForMs: f.heldForMs,
        },
        suggestedAction: 'review',
        confirmTicks: policy.triggers.confirmTicks,
        crossing: {
          level: f.price,
          threshold: f.takeProfitLevel,
          direction: 'above',
          band: bandOf(f.takeProfitLevel, policy),
        },
      });
    }

    return hits;
  },
};
