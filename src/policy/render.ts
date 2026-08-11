/**
 * L0 — the policy renderer.
 *
 * Interpolates policy.yaml values into policy/POLICY.md to produce the L3 system
 * prompt. The point is that a risk number appears in the prompt because it appears
 * in the policy — prose and machine config cannot drift.
 *
 * Every failure mode throws. A typo must NEVER render an empty string: that would
 * silently delete a risk rule from the system prompt, which is worse than a crash
 * at load because nothing would ever notice.
 */

import fs from 'fs';
import { getPolicy, TEMPLATE_FILE } from './load';
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
 * Trailing newlines are stripped: POLICY.md is a file and ends with one, the prompt
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

/** The L3 system prompt: policy/POLICY.md rendered against the active policy. */
export function renderPolicy(policy: Policy = getPolicy()): string {
  return renderTemplate(fs.readFileSync(TEMPLATE_FILE, 'utf8'), policy);
}
