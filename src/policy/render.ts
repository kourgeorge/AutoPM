/**
 * L0 — the policy renderer.
 *
 * Interpolates policy.yaml values into policy/PLAYBOOK.md to produce the L3 system
 * prompt. The point is that a risk number appears in the prompt because it appears
 * in the policy — prose and machine config cannot drift.
 *
 * Every failure mode throws. A typo must NEVER render an empty string: that would
 * silently delete a risk rule from the system prompt, which is worse than a crash
 * at load because nothing would ever notice.
 */

import { getPolicy, readPlaybook } from './load';
import type { Policy } from './types';

const PLACEHOLDER = /\{\{([^}|]+)(?:\|([^}]+))?\}\}/g;

type Filter = (value: unknown, key: string) => string;

/** Strip float artifacts: 0.155 * 100 = 15.500000000000002 must render as 15.5%. */
function clean(n: number): string {
  return String(Number(n.toFixed(6)));
}

function expectNumber(value: unknown, key: string, filter: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`policy template: ${key}|${filter} expects a finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

const FILTERS: Record<string, Filter> = {
  pct: (v, k) => `${clean(expectNumber(v, k, 'pct') * 100)}%`,

  usd: (v, k) =>
    `$${expectNumber(v, k, 'usd').toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`,

  min: (v, k) => `${clean(expectNumber(v, k, 'min') / 60_000)} min`,

  list: (v, k) => {
    if (!Array.isArray(v)) {
      throw new Error(`policy template: ${k}|list expects a list, got ${JSON.stringify(v)}`);
    }
    return v.join(', ');
  },
};

/** Walk a dotted path. Throws on a miss — an unknown key must not become ''. */
function resolve(policy: Policy, key: string): unknown {
  let cursor: unknown = policy;
  for (const part of key.split('.')) {
    if (typeof cursor !== 'object' || cursor === null || !(part in cursor)) {
      throw new Error(`policy template: unknown key {{${key}}}`);
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/**
 * Render a template against a policy.
 *
 * Trailing newlines are stripped: PLAYBOOK.md is a file and ends with one, the prompt
 * it replaces does not.
 */
export function renderTemplate(template: string, policy: Policy): string {
  const rendered = template.replace(PLACEHOLDER, (_match, rawKey: string, rawFilter?: string) => {
    const key = rawKey.trim();
    const value = resolve(policy, key);

    if (rawFilter === undefined) {
      if (typeof value === 'object' && value !== null) {
        throw new Error(`policy template: {{${key}}} is a ${Array.isArray(value) ? 'list' : 'mapping'} — needs a filter`);
      }
      return String(value);
    }

    const name = rawFilter.trim();
    const filter = FILTERS[name];
    if (!filter) {
      throw new Error(`policy template: unknown filter |${name} on {{${key}}} (have: ${Object.keys(FILTERS).join(', ')})`);
    }
    return filter(value, key);
  });

  return rendered.replace(/\n+$/, '');
}

/** The L3 system prompt: policy/PLAYBOOK.md rendered against the active policy. */
export function renderPolicy(policy: Policy = getPolicy()): string {
  const r = policy.risk;
  const configured = (value: number | null, suffix: string) => value == null ? 'not configured' : `${value}${suffix}`;
  return renderTemplate(readPlaybook(), policy) + `\n\nACTIVE RISK PROFILE (generated from saved settings)\n` +
    `Risk per trade: ${configured(r.riskPerTradePct, '% of equity at the planned stop')}. ` +
    `Annualized portfolio volatility target: ${configured(r.targetVolatilityPct, '%')}. ` +
    `Minimum planned reward:risk: ${configured(r.minRewardRisk, ':1')}.\n` +
    `These sizing instructions supersede older sizing prose in this account's playbook. positionSizePct is only a capital cap. ` +
    `Use get_watchlist_scan to compare portfolio risk fit, then get_entry_plan with a supported stop and target before execute_entry; request no more than maxQty. ` +
    `A sizing preview without a target does not clear reward:risk. Never invent a target or tighten a stop merely to qualify. ` +
    `When configured, volatility uses up to 60 completed daily return intervals, at least 30 aligned observations, annualized with 252 sessions. ` +
    `Missing required risk data blocks new entries. Unclassified holdings count conservatively toward sector overlap. ` +
    `A volatility target and a stop budget are estimates, not guaranteed outcomes; reward:risk does not establish positive expectancy. ` +
    `Leave cash uncommitted when no supported setup fits. Only the user changes the risk profile.\n`;
}
