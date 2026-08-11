/**
 * Data health — the detector that exists so silence is never mistaken for calm.
 *
 * Every other detector skips a subject whose inputs are stale. This one fires on
 * exactly those subjects, which is what closes the loop: a dead feed produces a
 * `data_stale` event instead of the absence of events.
 *
 * `boolCrossing` gives it a clean edge — one report per degradation episode per subject,
 * re-armed when the feed recovers, rather than one per tick for as long as it is down.
 */

import { boolCrossing, type Detector, type DetectorHit } from '../eventBus';

export const dataStaleDetector: Detector = {
  kind: 'data_stale',
  evaluate(data, _policy) {
    const hits: DetectorHit[] = [];

    // `maxQuoteAgeMs` is a market-hours rule. Overnight EVERY quote is legitimately older
    // than it, so ungated this produced one warn per position plus one per watchlist symbol
    // — ~19 events — every night, for a market that was simply shut.
    const quotesExpected = data.session === 'open';

    // Positions first — a stale quote on an open position is the case that matters, because
    // it is the one that silences the stop-breach detector.
    for (const f of quotesExpected ? Object.values(data.positions) : []) {
      hits.push({
        symbol: f.symbol,
        cooldownKey: `data_stale:${f.symbol}`,
        severity: 'warn',
        headline: `${f.symbol} price feed unreliable (position open) — ${f.staleReason ?? 'unknown'}`,
        evidence: {
          reason: f.staleReason ?? 'unknown',
          hasPosition: true,
        },
        suggestedAction: null,
        crossing: boolCrossing(f.stale),
      });
    }

    // Watchlist and positions are disjoint by construction in compute.ts, so the
    // `data_stale:${symbol}` keys cannot collide.
    for (const f of quotesExpected ? Object.values(data.watchlist) : []) {
      hits.push({
        symbol: f.symbol,
        cooldownKey: `data_stale:${f.symbol}`,
        severity: 'warn',
        headline: `${f.symbol} price feed unreliable — ${f.staleReason ?? 'unknown'}`,
        evidence: {
          reason: f.staleReason ?? 'unknown',
          hasPosition: false,
        },
        suggestedAction: null,
        crossing: boolCrossing(f.stale),
      });
    }

    // Deliberately NOT gated on the session: the broker's account endpoint answers 24/7,
    // so equity we cannot read at 03:00 is a real connectivity failure, not a closed market.
    // It is the one overnight staleness signal worth keeping.
    const a = data.account;
    hits.push({
      symbol: null,
      cooldownKey: 'data_stale:account',
      severity: 'warn',
      headline: `Account data unreliable — ${a.staleReason ?? 'unknown'}. Daily loss limit cannot be evaluated.`,
      evidence: {
        reason: a.staleReason ?? 'unknown',
        positionCount: a.positionCount,
      },
      suggestedAction: null,
      crossing: boolCrossing(a.stale),
    });

    return hits;
  },
};
