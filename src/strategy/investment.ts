import type { Policy } from '../policy/types';

/**
 * How the book's invested share compares with the profile's target and floor. Every other
 * risk setting is a ceiling; this is the one measurement that says "too little".
 */
export interface InvestmentGap {
  investedPct: number;
  targetPct: number | null;
  floorPct: number | null;
  belowTarget: boolean;
  belowFloor: boolean;
}

export function investmentGap(policy: Policy, grossDeployedPct: number | null | undefined): InvestmentGap | null {
  if (grossDeployedPct == null || !Number.isFinite(grossDeployedPct)) return null;
  const targetPct = policy.risk.targetInvestedPct ?? null, floorPct = policy.risk.minInvestedPct ?? null;
  return { investedPct: grossDeployedPct, targetPct, floorPct,
    belowTarget: targetPct != null && grossDeployedPct + 1e-9 < targetPct,
    belowFloor: floorPct != null && grossDeployedPct + 1e-9 < floorPct };
}

export function describeGap(gap: InvestmentGap): string {
  const parts = [`${gap.investedPct.toFixed(1)}% invested`];
  if (gap.targetPct != null) parts.push(`target ${gap.targetPct}%`);
  if (gap.floorPct != null) parts.push(`floor ${gap.floorPct}%`);
  return parts.join(', ');
}
