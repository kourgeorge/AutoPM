/**
 * L0 — the policy contract.
 *
 * Every behavioural number in the system is declared here and nowhere else.
 * `immutable` is the floor: the proposer cannot emit changes against it and the
 * loader refuses any policy that violates it.
 */

export interface RiskPolicy {
  maxPositions: number;
  positionSizePct: number;
  stopLossAtrMult: number;
  takeProfitAtrMult: number;
  maxDailyLossPct: number;
}

export interface StrategyPolicy {
  watchlist: string[];
  emaFast: number;
  emaSlow: number;
  rsiPeriod: number;
  rsiEntryMin: number;
  rsiExitMax: number;
  atrPeriod: number;
  minBars: number;
}

export interface TriggerPolicy {
  tickIntervalMs: number;
  positionDropPct: number;
  trailingDrawdownPct: number;
  positionSurgePct: number;
  hysteresisPct: number;
  defaultCooldownMs: number;
  criticalCooldownMs: number;
  heartbeatWithPositionsMs: number;
  heartbeatFlatMs: number;
  maxQuoteAgeMs: number;
}

/** Hard ceilings. Never proposable, always enforced at load. */
export interface ImmutablePolicy {
  maxPositionsCeiling: number;
  maxDailyLossPctCeiling: number;
  positionSizePctCeiling: number;
  stopLossAtrMultCeiling: number;
  minTickIntervalMs: number;
  requireStopOnEntry: boolean;
}

export interface Policy {
  version: number;
  risk: RiskPolicy;
  strategy: StrategyPolicy;
  triggers: TriggerPolicy;
  immutable: ImmutablePolicy;
}

/** Provenance of the currently loaded policy. */
export interface PolicyMeta {
  version: number;
  /** sha256 of the raw yaml text — identifies a policy exactly, including comments. */
  hash: string;
  loadedAt: string;
  source: string;
}

/** Result of a reload attempt. A failure leaves the previous policy active. */
export type PolicyLoadResult =
  | { ok: true; policy: Policy; meta: PolicyMeta }
  | { ok: false; errors: string[] };
