/**
 * L0 — the policy renderer.
 *
 * The system prompt is the account's playbook (prose only) followed by the ACTIVE POLICY block:
 * every configured number, as data, keyed by the dotted name the prose refers to it by
 * (`risk.maxPositions`). A number lives in one place — the saved settings — so prose and
 * machine config cannot drift, and there is no template to mistype. Until 2026-10-16 the
 * playbook carried `{{risk.maxPositions}}` placeholders and the account copies had drifted
 * into rules (a fixed 10% sizing formula) the settings no longer held.
 */

import { getPolicy, readPlaybook } from './load';
import { riskProfileName } from './riskProfiles';
import type { Policy } from './types';

const FRACTION = 'fraction of equity (0.1 = 10%)';
const POINTS = 'percentage points (10 = 10%)';
const MS = 'milliseconds';

/** Units for every field whose meaning is not obvious from its value. Anything else is a count, ratio or label. */
const UNITS: Record<string, string> = {
  'risk.riskPerTradePct': POINTS + ' of equity lost at the planned stop',
  'risk.targetVolatilityPct': POINTS + ' per year, estimated',
  'risk.minRewardRisk': 'ratio, (target - entry) / (entry - stop)',
  'risk.positionSizePct': FRACTION + ', capital cap per position',
  'risk.stopLossAtrMult': 'multiples of ATR, stop-distance guide',
  'risk.maxDailyLossPct': FRACTION + ', drawdown that halts entries for the day',
  'risk.maxGrossExposurePct': FRACTION + ', whole book',
  'risk.earningsBlackoutDays': 'days before a print',
  'risk.maxSingleWeightPct': POINTS + ' of equity in one name',
  'risk.maxSectorWeightPct': POINTS + ' of equity in one sector',
  'strategy.compositeMin': 'signal composite, -1..+1',
  'triggers.positionDropPct': POINTS, 'triggers.trailingDrawdownPct': POINTS, 'triggers.positionSurgePct': POINTS,
  'triggers.hysteresisPct': POINTS, 'triggers.portfolioDrawdownPct': POINTS + ' from the equity peak',
  'regime.*.sizeMult': 'multiplier on risk.positionSizePct (0.5 = half size)',
  'regime.*.compositeMin': 'signal composite, -1..+1; replaces strategy.compositeMin in that regime',
  'immutable.maxDailyLossPctCeiling': FRACTION, 'immutable.positionSizePctCeiling': FRACTION,
  'immutable.maxGrossExposurePctCeiling': FRACTION, 'immutable.stopLossAtrMultCeiling': 'multiples of ATR',
};

function unitFor(key: string): string | undefined {
  if (/Ms$/.test(key)) return MS;
  return UNITS[key] ?? UNITS[key.replace(/^regime\.[^.]+\./, 'regime.*.')];
}

/** Every policy value under its dotted name, with its unit where one is needed. */
export function policyFields(policy: Policy = getPolicy()): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (value: unknown, path: string) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
      return;
    }
    const unit = unitFor(path);
    out[path] = unit ? { value, unit } : value;
  };
  for (const section of ['risk', 'strategy', 'triggers', 'regime', 'automation', 'immutable'] as const) walk(policy[section], section);
  return out;
}

/** The structured block appended to the playbook. */
export function renderPolicyBlock(policy: Policy = getPolicy()): string {
  return `ACTIVE POLICY (generated from saved settings — the only source of these numbers; the playbook refers to them by name)\n` +
    JSON.stringify({ profile: riskProfileName(policy.risk), version: policy.version, nullMeans: 'not configured', fields: policyFields(policy) }, null, 2);
}

/**
 * The playbook is prose: a placeholder is refused, and so is a setting name that does not exist —
 * the check the template used to give, since a misspelt `risk.maxPostions` would otherwise point
 * the trader at nothing without anyone noticing.
 */
export function assertProsePlaybook(playbook: string, policy: Policy = getPolicy()): void {
  const placeholder = /\{\{[^}]*\}\}/.exec(playbook);
  if (placeholder) throw new Error(`The playbook is prose only; ${placeholder[0]} must be referred to by name (e.g. \`risk.maxPositions\`). Settings values are supplied separately as structured data.`);
  const keys = Object.keys(policyFields(policy));
  for (const [, name] of playbook.matchAll(/`((?:risk|strategy|triggers|regime|automation|immutable)\.[A-Za-z_.]+)`/g)) {
    if (!keys.some(k => k === name || k.startsWith(name + '.'))) throw new Error(`The playbook refers to \`${name}\`, which is not a setting`);
  }
}

/** The L3 system prompt: the account playbook followed by the active policy as data. */
export function renderPolicy(policy: Policy = getPolicy()): string {
  return readPlaybook().replace(/\n+$/, '') + '\n\n' + renderPolicyBlock(policy) + '\n';
}
