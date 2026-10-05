import type { RiskPolicy } from './types';

/** Presets populate explicit policy values; the label is always derived from those values. */
export const RISK_PROFILES = {
  conservative: { riskPerTradePct: 0.25, targetVolatilityPct: 8, minRewardRisk: 2,
    positionSizePct: 0.05, maxDailyLossPct: 0.01, maxGrossExposurePct: 0.5,
    maxSingleWeightPct: 5, maxSectorWeightPct: 20 },
  balanced: { riskPerTradePct: 0.5, targetVolatilityPct: 12, minRewardRisk: 2,
    positionSizePct: 0.1, maxDailyLossPct: 0.02, maxGrossExposurePct: 0.8,
    maxSingleWeightPct: 10, maxSectorWeightPct: 30 },
  aggressive: { riskPerTradePct: 1, targetVolatilityPct: 20, minRewardRisk: 2,
    positionSizePct: 0.1, maxDailyLossPct: 0.03, maxGrossExposurePct: 1,
    maxSingleWeightPct: 10, maxSectorWeightPct: 35 },
} as const;

export function riskProfileName(risk: RiskPolicy): string {
  return Object.entries(RISK_PROFILES).find(([, values]) =>
    Object.entries(values).every(([key, value]) => risk[key as keyof RiskPolicy] === value),
  )?.[0] ?? 'custom';
}

export function hasRiskProfile(risk: RiskPolicy): boolean {
  return risk.riskPerTradePct != null || risk.targetVolatilityPct != null || risk.minRewardRisk != null;
}
