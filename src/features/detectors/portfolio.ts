/**
 * L2 — portfolio-level detectors.
 *
 * `concentration()` is pure/sync specifically so a tick could call it (see
 * `strategy/exposure.ts`), but nothing did — the only paths to this data were an explicit
 * `get_exposure` call or the daily/weekly close review. These two detectors put the same
 * numbers on the clock, so a book drifting into one sector or one name growing past its
 * weight limit is caught between reviews.
 */

import type { Detector, DetectorHit } from '../eventBus';

export const portfolioDrawdownDetector: Detector = {
  kind: 'portfolio_drawdown',
  evaluate(data, policy) {
    const p = data.portfolio;
    if (p.drawdownFromPeakPct === null) return [];

    const hit: DetectorHit = {
      symbol: null,
      cooldownKey: 'portfolio_drawdown',
      severity: 'urgent', // a slower bleed that wants a decision, not a halt
      headline: `Portfolio is ${p.drawdownFromPeakPct.toFixed(2)}% below its equity peak of $${p.equityPeak.toFixed(2)}`,
      evidence: {
        drawdownFromPeakPct: p.drawdownFromPeakPct,
        equityPeak: p.equityPeak,
        equity: data.account.equity ?? 'n/a',
        positionCount: data.account.positionCount,
        grossDeployedPct: p.grossDeployedPct,
      },
      suggestedAction: 'resize',
      confirmTicks: policy.triggers.confirmTicks,
      crossing: {
        level: p.drawdownFromPeakPct,
        threshold: policy.triggers.portfolioDrawdownPct,
        direction: 'above',
        band: policy.triggers.hysteresisPct,
      },
    };
    return [hit];
  },
};

export const concentrationBreachDetector: Detector = {
  kind: 'concentration_breach',
  evaluate(data, policy) {
    const p = data.portfolio;

    const single: DetectorHit = {
      symbol: p.maxWeightSymbol,
      cooldownKey: `concentration_breach:single:${p.maxWeightSymbol ?? 'none'}`,
      severity: 'warn',
      headline: p.maxWeightSymbol === null
        ? 'Flat — no single-name concentration to measure'
        : `${p.maxWeightSymbol} is ${p.maxWeightPct.toFixed(1)}% of equity, above the ${policy.risk.maxSingleWeightPct}% single-name limit`,
      evidence: {
        maxWeightSymbol: p.maxWeightSymbol ?? 'n/a',
        maxWeightPct: p.maxWeightPct,
        threshold: policy.risk.maxSingleWeightPct,
      },
      suggestedAction: 'resize',
      confirmTicks: policy.triggers.confirmTicks,
      crossing: {
        level: p.maxWeightPct,
        threshold: policy.risk.maxSingleWeightPct,
        direction: 'above',
        band: policy.triggers.hysteresisPct,
      },
    };

    const sector: DetectorHit = {
      symbol: null,
      cooldownKey: `concentration_breach:sector:${p.maxSectorName ?? 'none'}`,
      severity: 'warn',
      headline: p.maxSectorName === null
        ? 'Flat or no sector data — no sector concentration to measure'
        : `${p.maxSectorName} is ${p.maxSectorWeightPct.toFixed(1)}% of equity, above the ${policy.risk.maxSectorWeightPct}% sector limit`,
      evidence: {
        maxSectorName: p.maxSectorName ?? 'n/a',
        maxSectorWeightPct: p.maxSectorWeightPct,
        threshold: policy.risk.maxSectorWeightPct,
      },
      suggestedAction: 'resize',
      confirmTicks: policy.triggers.confirmTicks,
      crossing: {
        level: p.maxSectorWeightPct,
        threshold: policy.risk.maxSectorWeightPct,
        direction: 'above',
        band: policy.triggers.hysteresisPct,
      },
    };

    return [single, sector];
  },
};
