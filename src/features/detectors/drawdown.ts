/**
 * Percentage-move detectors on open positions.
 *
 * Every level here is ALREADY a percentage point, so `hysteresisPct` is used directly as
 * the band — calling `bandOf` would take a percentage of a percentage and produce a band
 * ~200x too small, which is exactly the silent unit error this codebase is built to avoid.
 *
 * All three are percentages OF A LIVE PRICE, which makes them the same one-reading risk as
 * the stop: a single bad quote is a fabricated 50% drawdown. Hence `confirmTicks` here too.
 *
 * `trailing_drawdown` is the detector the old alert watcher could not express: it measures
 * from the durable `sessionHigh`, not from a last-observed price that ratcheted down with
 * every reading, so a slow bleed accumulates instead of resetting.
 */

import type { TickData } from '../compute';
import type { Detector, DetectorHit } from '../eventBus';
import { pctText } from './util';

/**
 * All three detectors here read only while the regular session is open — the same gate the
 * heartbeat uses, for the same reason: outside it nothing this system does can act on the
 * reading (its orders are market orders that wait for the open), and the reading itself is at
 * its least trustworthy (empty or one-sided books, a handful of extended-hours prints).
 *
 * Measured over 2026-09-04..10-03: 143 of 259 position alerts fired with the market shut, 125
 * of them `urgent` — one full LLM cycle each. Most landed at 00:00-00:01 ET, the minute the
 * daily reset releases every latch: `sessionHigh` and `entryPrice` are multi-day baselines,
 * so every position still below them re-fired at once about yesterday's close. Skipping the
 * reading (rather than downgrading its severity) leaves the released latch armed, so a
 * condition that still holds reports ONCE, at the open, on live trading — which is what the
 * reset's own comment always said the cost would be. `stop_breach` stays around the clock.
 */
function regularSession(data: TickData): boolean {
  return data.session === 'open';
}

export const trailingDrawdownDetector: Detector = {
  kind: 'trailing_drawdown',
  evaluate(data, policy) {
    const hits: DetectorHit[] = [];
    if (!regularSession(data)) return hits;

    for (const f of Object.values(data.positions)) {
      if (f.drawdownFromHighPct === null) continue;

      hits.push({
        symbol: f.symbol,
        cooldownKey: `trailing_drawdown:${f.symbol}`,
        severity: 'urgent',
        headline: `${f.symbol} trailing drawdown ${f.drawdownFromHighPct.toFixed(2)}% from session high ${f.sessionHigh.toFixed(2)} (${pctText(f.pnlPct)} on the position)`,
        evidence: {
          drawdownFromHighPct: f.drawdownFromHighPct,
          sessionHigh: f.sessionHigh,
          entryPrice: f.entryPrice,
          pnlPct: f.pnlPct ?? 'n/a',
          heldForMs: f.heldForMs ?? 'n/a',
        },
        suggestedAction: 'review',
        confirmTicks: policy.triggers.confirmTicks,
        crossing: {
          level: f.drawdownFromHighPct,
          threshold: policy.triggers.trailingDrawdownPct,
          direction: 'above',
          band: policy.triggers.hysteresisPct,
        },
      });
    }

    return hits;
  },
};

export const positionDropDetector: Detector = {
  kind: 'position_drop',
  evaluate(data, policy) {
    const hits: DetectorHit[] = [];
    if (!regularSession(data)) return hits;

    for (const f of Object.values(data.positions)) {
      if (f.pnlPct === null) continue;

      // Threshold is negated: the policy states the drop as a positive magnitude, the
      // feature carries a signed P&L.
      const threshold = -policy.triggers.positionDropPct;

      hits.push({
        symbol: f.symbol,
        cooldownKey: `position_drop:${f.symbol}`,
        severity: 'urgent',
        headline: `${f.symbol} down ${pctText(f.pnlPct)} from entry ${f.entryPrice.toFixed(2)}`,
        evidence: {
          pnlPct: f.pnlPct,
          entryPrice: f.entryPrice,
          threshold,
          heldForMs: f.heldForMs ?? 'n/a',
        },
        suggestedAction: 'review',
        confirmTicks: policy.triggers.confirmTicks,
        crossing: {
          level: f.pnlPct,
          threshold,
          direction: 'below',
          band: policy.triggers.hysteresisPct,
        },
      });
    }

    return hits;
  },
};

export const positionSurgeDetector: Detector = {
  kind: 'position_surge',
  evaluate(data, policy) {
    const hits: DetectorHit[] = [];
    if (!regularSession(data)) return hits;

    for (const f of Object.values(data.positions)) {
      if (f.pnlPct === null) continue;

      hits.push({
        symbol: f.symbol,
        cooldownKey: `position_surge:${f.symbol}`,
        // `warn`, not `urgent`: a gain is not an emergency. It reaches the user and the
        // next cycle's context without interrupting sleep.
        severity: 'warn',
        headline: `${f.symbol} up ${pctText(f.pnlPct)} from entry ${f.entryPrice.toFixed(2)} (MFE ${pctText(f.mfePct)})`,
        evidence: {
          pnlPct: f.pnlPct,
          entryPrice: f.entryPrice,
          mfePct: f.mfePct ?? 'n/a',
          heldForMs: f.heldForMs ?? 'n/a',
        },
        suggestedAction: 'review',
        confirmTicks: policy.triggers.confirmTicks,
        crossing: {
          level: f.pnlPct,
          threshold: policy.triggers.positionSurgePct,
          direction: 'above',
          band: policy.triggers.hysteresisPct,
        },
      });
    }

    return hits;
  },
};
