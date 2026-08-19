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
import type { Policy, PolicyLoadResult, PolicyMeta, RegimeOverride, RegimePolicy } from './types';
import { DATA_DIR } from '../core/paths';

/**
 * Read-only defaults shipped with the project source. These stay under `policy/` in the repo
 * whatever DATA_DIR is set to: they are tracked source, not per-broker record, and POLICY.md
 * is the system prompt itself.
 */
export const DEFAULT_POLICY_FILE = path.join(process.cwd(), 'policy', 'default.yaml');
export const TEMPLATE_FILE = path.join(process.cwd(), 'policy', 'POLICY.md');

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

function bool(src: Record<string, unknown>, where: string, key: string, errs: Errors): boolean {
  const v = src[key];
  if (typeof v !== 'boolean') {
    errs.push(`${where}.${key}: expected a boolean, got ${JSON.stringify(v)}`);
    return false;
  }
  return v;
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
    requireStopOnEntry: bool(imm, 'immutable', 'requireStopOnEntry', errs),
  };

  const r = block(root, 'risk', errs);
  const risk = {
    maxPositions: num(r, 'risk', 'maxPositions', errs, { int: true, min: 1, max: immutable.maxPositionsCeiling }),
    positionSizePct: num(r, 'risk', 'positionSizePct', errs, { min: 0, max: immutable.positionSizePctCeiling }),
    stopLossAtrMult: num(r, 'risk', 'stopLossAtrMult', errs, { min: 0, max: immutable.stopLossAtrMultCeiling }),
    takeProfitAtrMult: num(r, 'risk', 'takeProfitAtrMult', errs, { min: 0 }),
    maxDailyLossPct: num(r, 'risk', 'maxDailyLossPct', errs, { min: 0, max: immutable.maxDailyLossPctCeiling }),
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
  };
  if (strategy.emaFast >= strategy.emaSlow) {
    errs.push(`strategy: emaFast (${strategy.emaFast}) must be < emaSlow (${strategy.emaSlow})`);
  }

  // Regime overrides — optional with sensible defaults
  const DEFAULT_REGIME: RegimePolicy = {
    expansion:  { sizeMult: 1.0, rsiEntryMin: strategy.rsiEntryMin },
    recovery:   { sizeMult: 1.0, rsiEntryMin: strategy.rsiEntryMin },
    late_cycle: { sizeMult: 0.75, rsiEntryMin: Math.min(strategy.rsiEntryMin + 5, 100) },
    recession:  { sizeMult: 0.5, rsiEntryMin: Math.min(strategy.rsiEntryMin + 10, 100) },
  };

  const regimeRaw = isRecord(root.regime) ? root.regime : {};
  const parseOverride = (key: string): RegimeOverride => {
    const raw = isRecord(regimeRaw[key]) ? regimeRaw[key] as Record<string, unknown> : {};
    return {
      sizeMult: typeof raw.sizeMult === 'number' ? raw.sizeMult : (DEFAULT_REGIME as any)[key].sizeMult,
      rsiEntryMin: typeof raw.rsiEntryMin === 'number' ? raw.rsiEntryMin : (DEFAULT_REGIME as any)[key].rsiEntryMin,
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
    defaultCooldownMs: num(t, 'triggers', 'defaultCooldownMs', errs, { int: true, min: 0 }),
    criticalCooldownMs: num(t, 'triggers', 'criticalCooldownMs', errs, { int: true, min: 0 }),
    heartbeatWithPositionsMs: num(t, 'triggers', 'heartbeatWithPositionsMs', errs, { int: true, min: 0 }),
    heartbeatFlatMs: num(t, 'triggers', 'heartbeatFlatMs', errs, { int: true, min: 0 }),
    maxQuoteAgeMs: num(t, 'triggers', 'maxQuoteAgeMs', errs, { int: true, min: 0 }),
  };

  return { policy: { version, risk, strategy, triggers, regime, immutable }, errors: errs };
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

/** Raw yaml text of the active policy file. Used by mutate.ts and history snapshots. */
export function readPolicyText(): string {
  return fs.readFileSync(POLICY_FILE, 'utf8');
}
