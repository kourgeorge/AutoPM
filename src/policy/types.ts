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
  maxDailyLossPct: number;
  /**
   * Gross exposure ceiling as a fraction of equity (1.0 = 100%, fully deployed on no margin).
   *
   * `maxPositions x positionSizePct` alone can add up past this — ten correctly-sized positions
   * still leave no headroom check on the book as a whole. This is that check, enforced by
   * `exposureVeto` in orderManager.ts.
   */
  maxGrossExposurePct: number;
  /**
   * Minimum days until the next earnings print required to open a new position.
   *
   * An earnings gap jumps past a resting stop, so this is the one entry risk `stopLossAtrMult`
   * cannot bound. POLICY.md stated this as prose for as long as it existed; this is the number
   * `earningsVeto` in orderManager.ts actually enforces, and the prompt is templated from it so
   * the two cannot drift.
   */
  earningsBlackoutDays: number;
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
  /**
   * Minimum `SignalTally.composite` required to open a position, -1..+1.
   *
   * The single definition of the entry gate. It is enforced by `enterPosition` (`low_composite`),
   * arms the `entry_signal` detector, and is rendered into POLICY.md by the template — so the
   * prompt cannot state a threshold the machine does not hold.
   */
  compositeMin: number;
}

export interface TriggerPolicy {
  tickIntervalMs: number;
  positionDropPct: number;
  trailingDrawdownPct: number;
  positionSurgePct: number;
  hysteresisPct: number;
  /** Consecutive breached readings required before a price-derived level fires. */
  confirmTicks: number;
  defaultCooldownMs: number;
  criticalCooldownMs: number;
  heartbeatWithPositionsMs: number;
  heartbeatFlatMs: number;
  maxQuoteAgeMs: number;
}

/** Per-regime behavioural overrides. Applied deterministically by the guard layer. */
export interface RegimeOverride {
  /** Multiplier on positionSizePct (1.0 = no change, 0.5 = half size). */
  sizeMult: number;
  /** Minimum RSI required for entry signal to arm. Overrides strategy.rsiEntryMin per regime. */
  rsiEntryMin: number;
  /**
   * Minimum composite required to enter. Overrides strategy.compositeMin per regime.
   *
   * This is where "tighten entry criteria in a late cycle" stops being advice: the guard reads
   * it, so a weak setup is refused rather than argued with.
   */
  compositeMin: number;
}

export interface RegimePolicy {
  expansion: RegimeOverride;
  recovery: RegimeOverride;
  late_cycle: RegimeOverride;
  recession: RegimeOverride;
}

/** Hard ceilings. Never proposable, always enforced at load. */
export interface ImmutablePolicy {
  maxPositionsCeiling: number;
  maxDailyLossPctCeiling: number;
  positionSizePctCeiling: number;
  stopLossAtrMultCeiling: number;
  minTickIntervalMs: number;
  maxGrossExposurePctCeiling: number;
}

/** Which trader actions the operator approval gate covers. One key per ENFORCED action. */
export interface ApprovalRequire {
  /** `execute_entry` — new capital committed. */
  entry: boolean;
  /** `execute_exit` — closing a position. See the warning in `policy/default.yaml`. */
  exit: boolean;
}

/** When the gate is armed. `live_only` reads `config.venue`, which is derived from the endpoint. */
export type ApprovalMode = 'off' | 'live_only' | 'always';

/** What an unanswered request settles as. */
export type ApprovalTimeout = 'deny' | 'allow';

/**
 * The operator approval gate.
 *
 * Behaviour, so it lives here rather than in `core/config.ts`: an operator tunes it to
 * change how the system trades. It is deliberately absent from `PolicyMutation` in
 * `policy/mutate.ts` — the concierge's `update_policy` must not be able to disarm the gate
 * on the operator's behalf. Only a human editing policy.yaml can.
 */
export interface ApprovalPolicy {
  mode: ApprovalMode;
  /** How long a request waits for an answer before settling as `onTimeout`. */
  timeoutMs: number;
  onTimeout: ApprovalTimeout;
  require: ApprovalRequire;
}

export interface Policy {
  version: number;
  risk: RiskPolicy;
  strategy: StrategyPolicy;
  triggers: TriggerPolicy;
  regime: RegimePolicy;
  approval: ApprovalPolicy;
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
