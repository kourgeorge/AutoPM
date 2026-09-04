/**
 * L0 — the policy loader.
 *
 * Parses data/policy/policy.yaml, validates it against its own `immutable` ceilings,
 * hashes the raw text, and holds it in memory. Edits are hot-reloaded.
 *
 * The project ships a read-only default at policy/default.yaml. On first run,
 * if no live policy exists yet, it is copied to data/policy/policy.yaml. All
 * subsequent reads and writes go through data/policy/ — which is gitignored so
 * user edits and version history are never committed.
 *
 * Failure semantics differ deliberately by phase:
 *  - the FIRST load throws. There is nothing to fall back to, so a broken policy
 *    must stop the daemon rather than let it run on defaults nobody declared.
 *  - a RELOAD never throws. It returns the errors and leaves the previously
 *    loaded policy active, so a typo cannot take a running daemon down.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { load as parseYaml } from 'js-yaml';
import { logger } from '../core/logger';
import type {
  AutomationPolicy,
  Policy,
  PolicyLoadResult,
  PolicyMeta,
  RegimeOverride,
  RegimePolicy,
} from './types';
import { DATA_DIR } from '../core/paths';

/**
 * Read-only defaults shipped with the project source. These stay under `policy/` in the repo
 * whatever DATA_DIR is set to: they are tracked source, not per-broker record, and PLAYBOOK.md
 * is the system prompt itself.
 */
export const DEFAULT_POLICY_FILE = path.join(process.cwd(), 'policy', 'default.yaml');
export const TEMPLATE_FILE = path.join(process.cwd(), 'policy', 'PLAYBOOK.md');

/** Live (user-managed) policy and its history — inside the gitignored data directory. */
export const DATA_POLICY_DIR = path.join(DATA_DIR, 'policy');
export const POLICY_FILE = path.join(DATA_POLICY_DIR, 'policy.yaml');
export const HISTORY_DIR = path.join(DATA_POLICY_DIR, 'history');

/** Ensure data/policy/policy.yaml exists, seeding from the project default if not. */
function ensureLivePolicy(): void {
  if (!fs.existsSync(POLICY_FILE)) {
    fs.mkdirSync(DATA_POLICY_DIR, { recursive: true });
    fs.copyFileSync(DEFAULT_POLICY_FILE, POLICY_FILE);
    logger.info(`[Policy] Seeded data/policy/policy.yaml from policy/default.yaml`);
  }
}

let _policy: Policy | null = null;
let _meta: PolicyMeta | null = null;

// ── Validation ────────────────────────────────────────────────────────────────

type Errors = string[];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function block(root: Record<string, unknown>, name: string, errs: Errors): Record<string, unknown> {
  const v = root[name];
  if (!isRecord(v)) {
    errs.push(`${name}: missing or not a mapping`);
    return {};
  }
  return v;
}

/**
 * Fallback for `triggers.confirmTicks` when the key is absent. Two readings, i.e. one tick
 * of extra latency at the default cadence, which is the cheapest confirmation that exists.
 */
const DEFAULT_CONFIRM_TICKS = 2;

/**
 * Fallback for `strategy.compositeMin` when the key is absent, and the value PLAYBOOK.md stated as
 * prose for the whole time nothing enforced it.
 *
 * Optional for the same reason as `confirmTicks` above: every policy.yaml written before the
 * entry gate existed is missing this key, the first load THROWS on a validation error, and
 * requiring it would take down every daemon that upgraded. The fallback is the threshold the
 * prompt already asked the model to apply to itself, so an operator who has never heard of the
 * field inherits the rule they were already meant to be following.
 */
const DEFAULT_COMPOSITE_MIN = 0.2;

/**
 * Fallback for `risk.maxGrossExposurePct` / `immutable.maxGrossExposurePctCeiling` when absent —
 * same reason as `compositeMin` above: every policy.yaml written before the exposure guard
 * existed is missing these keys, and the first load throws on a validation error. 1.0 (100% of
 * equity) is the ceiling the default `maxPositions x positionSizePct` already implies, so an
 * operator who has never heard of the field inherits the limit their book was already sized to.
 */
const DEFAULT_MAX_GROSS_EXPOSURE_PCT = 1.0;
const DEFAULT_MAX_GROSS_EXPOSURE_PCT_CEILING = 1.5;

/**
 * Fallback for `risk.earningsBlackoutDays` when absent — same reason as `compositeMin` above:
 * every policy.yaml written before the guard existed is missing this key, and the first load
 * THROWS on a validation error. 5 is the number PLAYBOOK.md stated as prose for as long as this
 * was unenforced, so an operator who has never heard of the field inherits the rule they were
 * already meant to be following.
 */
const DEFAULT_EARNINGS_BLACKOUT_DAYS = 5;

/**
 * Fallbacks for the three P3 (portfolio doctor) keys when absent — same reason as
 * `compositeMin` above: every policy.yaml written before these guards existed is missing
 * them, and the first load THROWS on a validation error. 6% / 15% / 35% are the values this
 * plan ships as the live defaults, so an operator who has never heard of the fields inherits
 * exactly what a fresh install would have set.
 */
const DEFAULT_PORTFOLIO_DRAWDOWN_PCT = 6;
const DEFAULT_MAX_SINGLE_WEIGHT_PCT = 15;
const DEFAULT_MAX_SECTOR_WEIGHT_PCT = 35;

function num(
  src: Record<string, unknown>,
  where: string,
  key: string,
  errs: Errors,
  opts: { min?: number; max?: number; int?: boolean } = {},
): number {
  const v = src[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errs.push(`${where}.${key}: expected a finite number, got ${JSON.stringify(v)}`);
    return NaN;
  }
  if (opts.int && !Number.isInteger(v)) errs.push(`${where}.${key}: expected an integer, got ${v}`);
  if (opts.min !== undefined && v < opts.min) errs.push(`${where}.${key}: ${v} < minimum ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) errs.push(`${where}.${key}: ${v} > maximum ${opts.max}`);
  return v;
}

/**
 * One of a fixed set of strings. Absent is NOT handled here — the caller decides whether a
 * missing key is an error or a default, because those differ per block.
 */
function enumOf<T extends string>(
  src: Record<string, unknown>,
  where: string,
  key: string,
  allowed: readonly T[],
  errs: Errors,
): T | undefined {
  const v = src[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    errs.push(`${where}.${key}: expected one of ${allowed.join(' | ')}, got ${JSON.stringify(v)}`);
    return undefined;
  }
  return v as T;
}

function symbolList(src: Record<string, unknown>, where: string, key: string, errs: Errors): string[] {
  const v = src[key];
  if (!Array.isArray(v) || v.length === 0) {
    errs.push(`${where}.${key}: expected a non-empty list`);
    return [];
  }
  const bad = v.filter((s) => typeof s !== 'string' || !/^[A-Z.\-]{1,10}$/.test(s));
  if (bad.length > 0) errs.push(`${where}.${key}: not ticker symbols: ${JSON.stringify(bad)}`);
  return v as string[];
}

/**
 * Validate a parsed document into a Policy.
 *
 * `immutable` is read FIRST because the risk block is validated against it. The
 * ceilings are not duplicated in TypeScript — that would re-scatter the numbers
 * this file exists to centralise.
 */
function validate(doc: unknown): { policy: Policy; errors: Errors } {
  const errs: Errors = [];
  const root = isRecord(doc) ? doc : (errs.push('policy: root is not a mapping'), {});

  const version = num(root, 'policy', 'version', errs, { int: true, min: 1 });

  const imm = block(root, 'immutable', errs);
  const immutable = {
    maxPositionsCeiling: num(imm, 'immutable', 'maxPositionsCeiling', errs, { int: true, min: 1 }),
    maxDailyLossPctCeiling: num(imm, 'immutable', 'maxDailyLossPctCeiling', errs, { min: 0 }),
    positionSizePctCeiling: num(imm, 'immutable', 'positionSizePctCeiling', errs, { min: 0 }),
    stopLossAtrMultCeiling: num(imm, 'immutable', 'stopLossAtrMultCeiling', errs, { min: 0 }),
    minTickIntervalMs: num(imm, 'immutable', 'minTickIntervalMs', errs, { int: true, min: 1 }),
    maxGrossExposurePctCeiling: imm.maxGrossExposurePctCeiling === undefined
      ? DEFAULT_MAX_GROSS_EXPOSURE_PCT_CEILING
      : num(imm, 'immutable', 'maxGrossExposurePctCeiling', errs, { min: 0 }),
  };

  const r = block(root, 'risk', errs);
  const risk = {
    maxPositions: num(r, 'risk', 'maxPositions', errs, { int: true, min: 1, max: immutable.maxPositionsCeiling }),
    positionSizePct: num(r, 'risk', 'positionSizePct', errs, { min: 0, max: immutable.positionSizePctCeiling }),
    stopLossAtrMult: num(r, 'risk', 'stopLossAtrMult', errs, { min: 0, max: immutable.stopLossAtrMultCeiling }),
    maxDailyLossPct: num(r, 'risk', 'maxDailyLossPct', errs, { min: 0, max: immutable.maxDailyLossPctCeiling }),
    maxGrossExposurePct: r.maxGrossExposurePct === undefined
      ? DEFAULT_MAX_GROSS_EXPOSURE_PCT
      : num(r, 'risk', 'maxGrossExposurePct', errs, { min: 0, max: immutable.maxGrossExposurePctCeiling }),
    earningsBlackoutDays: r.earningsBlackoutDays === undefined
      ? DEFAULT_EARNINGS_BLACKOUT_DAYS
      : num(r, 'risk', 'earningsBlackoutDays', errs, { int: true, min: 0, max: 30 }),
    maxSingleWeightPct: r.maxSingleWeightPct === undefined
      ? DEFAULT_MAX_SINGLE_WEIGHT_PCT
      : num(r, 'risk', 'maxSingleWeightPct', errs, { min: 0, max: 100 }),
    maxSectorWeightPct: r.maxSectorWeightPct === undefined
      ? DEFAULT_MAX_SECTOR_WEIGHT_PCT
      : num(r, 'risk', 'maxSectorWeightPct', errs, { min: 0, max: 100 }),
  };

  const s = block(root, 'strategy', errs);
  const strategy = {
    watchlist: symbolList(s, 'strategy', 'watchlist', errs),
    emaFast: num(s, 'strategy', 'emaFast', errs, { int: true, min: 1 }),
    emaSlow: num(s, 'strategy', 'emaSlow', errs, { int: true, min: 1 }),
    rsiPeriod: num(s, 'strategy', 'rsiPeriod', errs, { int: true, min: 1 }),
    rsiEntryMin: num(s, 'strategy', 'rsiEntryMin', errs, { min: 0, max: 100 }),
    rsiExitMax: num(s, 'strategy', 'rsiExitMax', errs, { min: 0, max: 100 }),
    atrPeriod: num(s, 'strategy', 'atrPeriod', errs, { int: true, min: 1 }),
    minBars: num(s, 'strategy', 'minBars', errs, { int: true, min: 1 }),
    // Bounded by the composite's own range rather than by taste: it is a mean of five scores each
    // in -1..+1, so a threshold outside that is unsatisfiable (above +1) or vacuous (below -1),
    // and both are configuration errors worth naming at load rather than at the first entry.
    compositeMin: s.compositeMin === undefined
      ? DEFAULT_COMPOSITE_MIN
      : num(s, 'strategy', 'compositeMin', errs, { min: -1, max: 1 }),
  };
  if (strategy.emaFast >= strategy.emaSlow) {
    errs.push(`strategy: emaFast (${strategy.emaFast}) must be < emaSlow (${strategy.emaSlow})`);
  }

  // Regime overrides — optional with sensible defaults.
  //
  // `round2` is not cosmetic: the derived thresholds are sums of decimals, so 0.2 + 0.10 is
  // 0.30000000000000004 in binary floating point, and that number would be carried verbatim into
  // `entry_signal` evidence and into the journal. A threshold is a policy statement, and one
  // written with seventeen digits reads as a computed artefact rather than as somebody's decision.
  const round2 = (n: number) => parseFloat(n.toFixed(2));
  const DEFAULT_REGIME: RegimePolicy = {
    expansion:  { sizeMult: 1.0, rsiEntryMin: strategy.rsiEntryMin, compositeMin: strategy.compositeMin },
    recovery:   { sizeMult: 1.0, rsiEntryMin: strategy.rsiEntryMin, compositeMin: strategy.compositeMin },
    late_cycle: { sizeMult: 0.75, rsiEntryMin: Math.min(strategy.rsiEntryMin + 5, 100), compositeMin: round2(Math.min(strategy.compositeMin + 0.05, 1)) },
    recession:  { sizeMult: 0.5, rsiEntryMin: Math.min(strategy.rsiEntryMin + 10, 100), compositeMin: round2(Math.min(strategy.compositeMin + 0.10, 1)) },
  };

  const regimeRaw = isRecord(root.regime) ? root.regime : {};
  const parseOverride = (key: string): RegimeOverride => {
    const raw = isRecord(regimeRaw[key]) ? regimeRaw[key] as Record<string, unknown> : {};
    return {
      sizeMult: typeof raw.sizeMult === 'number' ? raw.sizeMult : (DEFAULT_REGIME as any)[key].sizeMult,
      rsiEntryMin: typeof raw.rsiEntryMin === 'number' ? raw.rsiEntryMin : (DEFAULT_REGIME as any)[key].rsiEntryMin,
      compositeMin: typeof raw.compositeMin === 'number' ? raw.compositeMin : (DEFAULT_REGIME as any)[key].compositeMin,
    };
  };

  const regime: RegimePolicy = {
    expansion: parseOverride('expansion'),
    recovery: parseOverride('recovery'),
    late_cycle: parseOverride('late_cycle'),
    recession: parseOverride('recession'),
  };

  const t = block(root, 'triggers', errs);
  const triggers = {
    tickIntervalMs: num(t, 'triggers', 'tickIntervalMs', errs, { int: true, min: immutable.minTickIntervalMs }),
    positionDropPct: num(t, 'triggers', 'positionDropPct', errs, { min: 0 }),
    trailingDrawdownPct: num(t, 'triggers', 'trailingDrawdownPct', errs, { min: 0 }),
    positionSurgePct: num(t, 'triggers', 'positionSurgePct', errs, { min: 0 }),
    hysteresisPct: num(t, 'triggers', 'hysteresisPct', errs, { min: 0 }),
    // Optional, and defaulting to CONFIRMATION rather than to the old behaviour. Every
    // policy.yaml written before gate 0 existed is missing this key, and the first load
    // THROWS on a validation error, so requiring it would take down every daemon that
    // upgraded. The fallback is 2 and not 1 because 1 *is* the fire-on-one-reading bug the
    // gate exists to remove: an operator who has never heard of the field should inherit the
    // protection, not the thing it protects against.
    confirmTicks: t.confirmTicks === undefined
      ? DEFAULT_CONFIRM_TICKS
      : num(t, 'triggers', 'confirmTicks', errs, { int: true, min: 1, max: 10 }),
    defaultCooldownMs: num(t, 'triggers', 'defaultCooldownMs', errs, { int: true, min: 0 }),
    criticalCooldownMs: num(t, 'triggers', 'criticalCooldownMs', errs, { int: true, min: 0 }),
    heartbeatWithPositionsMs: num(t, 'triggers', 'heartbeatWithPositionsMs', errs, { int: true, min: 0 }),
    heartbeatFlatMs: num(t, 'triggers', 'heartbeatFlatMs', errs, { int: true, min: 0 }),
    maxQuoteAgeMs: num(t, 'triggers', 'maxQuoteAgeMs', errs, { int: true, min: 0 }),
    portfolioDrawdownPct: t.portfolioDrawdownPct === undefined
      ? DEFAULT_PORTFOLIO_DRAWDOWN_PCT
      : num(t, 'triggers', 'portfolioDrawdownPct', errs, { min: 0 }),
  };


  // ── Automation gate ─────────────────────────────────────────────────────────
  //
  // Optional block, ARMED by default. Every policy.yaml written before the gate existed is
  // missing it, and the first load THROWS on a validation error (see the header) — so
  // requiring the block would take down every daemon that upgraded. The level defaults to
  // manual entry/exit rather than auto: an operator who has never heard of this feature
  // should find their account gated, not silently unguarded. The level applies uniformly on
  // paper and live — there is no venue-based exemption.
  //
  // Stricter than `regime` above on purpose. There, a wrong type falls back to the default;
  // here it is an error. Each `level.*` entry: `manual` misspelled must not silently read as
  // `auto` — on a safety gate, a typo that reads as "configured" is the whole failure mode.
  const DEFAULT_AUTOMATION: AutomationPolicy = {
    level: { entry: 'manual', exit: 'manual', stopAdjust: 'auto', targetAdjust: 'auto' },
    timeoutMs: 600_000,
    onTimeout: 'deny',
  };

  const a = isRecord(root.automation) ? root.automation : {};
  if (root.automation !== undefined && !isRecord(root.automation)) {
    errs.push('automation: present but not a mapping');
  }
  const levelRaw = isRecord(a.level) ? a.level : {};
  if (a.level !== undefined && !isRecord(a.level)) {
    errs.push('automation.level: present but not a mapping');
  }

  const LEVELS = ['auto', 'manual'] as const;
  const level = (key: keyof AutomationPolicy['level']) =>
    enumOf(levelRaw, 'automation.level', key, LEVELS, errs) ?? DEFAULT_AUTOMATION.level[key];

  const automation: AutomationPolicy = {
    level: {
      entry: level('entry'),
      exit: level('exit'),
      stopAdjust: level('stopAdjust'),
      targetAdjust: level('targetAdjust'),
    },
    // Floors at 5s (an unanswerable window is a denial with extra steps) and caps at 24h.
    timeoutMs: a.timeoutMs === undefined
      ? DEFAULT_AUTOMATION.timeoutMs
      : num(a, 'automation', 'timeoutMs', errs, { int: true, min: 5_000, max: 86_400_000 }),
    onTimeout: enumOf(a, 'automation', 'onTimeout', ['deny', 'allow'] as const, errs)
      ?? DEFAULT_AUTOMATION.onTimeout,
  };

  return { policy: { version, risk, strategy, triggers, regime, automation, immutable }, errors: errs };
}

// ── Loading ───────────────────────────────────────────────────────────────────

/** Parse + validate raw yaml text. Pure — touches no module state. */
export function parsePolicy(text: string, source = POLICY_FILE): PolicyLoadResult {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err: any) {
    return { ok: false, errors: [`yaml parse failed: ${err.message}`] };
  }

  const { policy, errors } = validate(doc);
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    policy,
    meta: {
      version: policy.version,
      hash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 12),
      loadedAt: new Date().toISOString(),
      source,
    },
  };
}

/** First load. Throws — there is no previous policy to keep. */
export function loadPolicy(): Policy {
  ensureLivePolicy();
  const text = fs.readFileSync(POLICY_FILE, 'utf8');
  const result = parsePolicy(text);
  if (!result.ok) {
    throw new Error(`Invalid policy at ${POLICY_FILE}:\n  - ${result.errors.join('\n  - ')}`);
  }
  _policy = result.policy;
  _meta = result.meta;
  logger.info(`[Policy] Loaded v${result.meta.version} (${result.meta.hash})`);
  return result.policy;
}

/** Reload after an edit. Never throws; a failure leaves the active policy in place. */
export function reloadPolicy(): PolicyLoadResult {
  let text: string;
  try {
    text = fs.readFileSync(POLICY_FILE, 'utf8');
  } catch (err: any) {
    return { ok: false, errors: [`cannot read ${POLICY_FILE}: ${err.message}`] };
  }

  const result = parsePolicy(text);
  if (!result.ok) return result;

  const previous = _meta;
  _policy = result.policy;
  _meta = result.meta;
  if (previous?.hash !== result.meta.hash) {
    logger.info(`[Policy] Reloaded v${result.meta.version} (${previous?.hash ?? 'none'} → ${result.meta.hash})`);
  }
  return result;
}

export function getPolicy(): Policy {
  return _policy ?? loadPolicy();
}

/**
 * Test-only seam, mirroring `useEphemeralState`/`useEphemeralJournal`: swap the in-memory
 * active policy without touching `POLICY_FILE`. Exists because `automationLevel()` and
 * `enterPosition`/`exitPosition`/`toolAnnotatePosition` all read `getPolicy()` directly rather
 * than taking a policy parameter — the replay harness needs a way to flip `automation.level`
 * to `manual` for a manual-path scenario without writing to the operator's real policy file.
 */
export function useEphemeralPolicy(policy: Policy): void {
  _policy = policy;
  _meta = { version: policy.version, hash: 'ephemeral', loadedAt: new Date().toISOString(), source: 'ephemeral' };
}

/** Raw yaml text of the active policy file. Used by mutate.ts and history snapshots. */
export function readPolicyText(): string {
  return fs.readFileSync(POLICY_FILE, 'utf8');
}
