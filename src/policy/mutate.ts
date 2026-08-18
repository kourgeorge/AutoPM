/**
 * L0 — policy mutation.
 *
 * The only write path to policy.yaml that is not a human editor. Validates
 * the proposed change before touching disk and backs up the previous file
 * to policy/history/ so every change is reversible.
 *
 * Deliberately narrow: only the fields a user would express as a preference
 * ("add TSLA", "reduce position size to 3%") are exposed. Immutable ceilings
 * are enforced by the existing parsePolicy validator — this file does not
 * re-implement them.
 */

import fs from 'fs';
import path from 'path';
import { dump as dumpYaml, load as parseYamlDoc } from 'js-yaml';
import { HISTORY_DIR, POLICY_FILE, parsePolicy, readPolicyText, reloadPolicy } from './load';

export interface PolicyMutation {
  /** Add these symbols to the watchlist (idempotent). */
  addToWatchlist?: string[];
  /** Remove these symbols from the watchlist. */
  removeFromWatchlist?: string[];
  /** Replace the entire watchlist. */
  setWatchlist?: string[];
  /** risk.maxPositions */
  maxPositions?: number;
  /** risk.positionSizePct — fraction, e.g. 0.03 for 3% */
  positionSizePct?: number;
  /** risk.stopLossAtrMult */
  stopLossAtrMult?: number;
  /** risk.takeProfitAtrMult */
  takeProfitAtrMult?: number;
  /** risk.maxDailyLossPct — fraction, e.g. 0.03 for 3% */
  maxDailyLossPct?: number;
}

export type MutateResult =
  | { ok: true;  applied: string[]; version: number }
  | { ok: false; errors: string[] };

export function mutatePolicy(changes: PolicyMutation): MutateResult {
  let text: string;
  try {
    text = readPolicyText();
  } catch (err: any) {
    return { ok: false, errors: [`cannot read policy: ${err.message}`] };
  }

  let doc: any;
  try {
    doc = parseYamlDoc(text);
  } catch (err: any) {
    return { ok: false, errors: [`cannot parse current policy: ${err.message}`] };
  }

  // A policy missing either section is a broken file, not a mutation to apply blindly:
  // `doc.strategy.watchlist = ...` throws a TypeError on an absent section, and a THROW from
  // here escapes past every caller, which all expect the `{ ok: false }` channel.
  if (doc == null || typeof doc !== 'object') {
    return { ok: false, errors: ['policy.yaml did not parse to an object'] };
  }
  for (const section of ['strategy', 'risk'] as const) {
    if (doc[section] == null || typeof doc[section] !== 'object') {
      return { ok: false, errors: [`policy.yaml has no ${section} section — refusing to create one`] };
    }
  }

  const applied: string[] = [];

  // ── Watchlist ──────────────────────────────────────────────────────────────
  let watchlist: string[] = Array.isArray(doc.strategy?.watchlist)
    ? [...doc.strategy.watchlist]
    : [];

  if (changes.setWatchlist) {
    const prev = watchlist.join(', ');
    watchlist = [...changes.setWatchlist];
    applied.push(`watchlist replaced [${prev}] → [${watchlist.join(', ')}]`);
  } else {
    if (changes.addToWatchlist?.length) {
      const toAdd = changes.addToWatchlist.filter(s => !watchlist.includes(s));
      if (toAdd.length) {
        watchlist = [...watchlist, ...toAdd];
        applied.push(`watchlist +[${toAdd.join(', ')}]`);
      }
    }
    if (changes.removeFromWatchlist?.length) {
      const removed = changes.removeFromWatchlist.filter(s => watchlist.includes(s));
      if (removed.length) {
        watchlist = watchlist.filter(s => !changes.removeFromWatchlist!.includes(s));
        applied.push(`watchlist -[${removed.join(', ')}]`);
      }
    }
  }
  doc.strategy.watchlist = watchlist;

  // ── Risk ───────────────────────────────────────────────────────────────────
  const riskFields: Array<[keyof PolicyMutation & keyof typeof doc.risk, string]> = [
    ['maxPositions',      'risk.maxPositions'],
    ['positionSizePct',   'risk.positionSizePct'],
    ['stopLossAtrMult',   'risk.stopLossAtrMult'],
    ['takeProfitAtrMult', 'risk.takeProfitAtrMult'],
    ['maxDailyLossPct',   'risk.maxDailyLossPct'],
  ];
  for (const [field, label] of riskFields) {
    const v = changes[field as keyof PolicyMutation];
    if (v !== undefined) {
      const prev = doc.risk[field];
      doc.risk[field] = v;
      applied.push(`${label}: ${prev} → ${v}`);
    }
  }

  if (applied.length === 0) {
    return { ok: true, applied: [], version: doc.version };
  }

  doc.version = (doc.version ?? 0) + 1;

  const newText = dumpYaml(doc, { lineWidth: -1 });

  // Validate before touching disk
  const validation = parsePolicy(newText);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }

  // Backup previous file
  try {
    if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(HISTORY_DIR, `policy-${stamp}.yaml`), text, 'utf8');
  } catch {
    // Non-fatal — a backup failure must not block the mutation
  }

  // Written via a temp file in the SAME directory and renamed, because `rename` within a
  // filesystem is atomic while `writeFileSync` truncates first: a crash mid-write left a
  // half-parsed policy.yaml behind, and policy is the file every startup path needs to read.
  // The backup above is not the answer to that — restoring it is a manual step, and the
  // daemon would already be down.
  const tmp = `${POLICY_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, newText, 'utf8');
    fs.renameSync(tmp, POLICY_FILE);
  } catch (err: any) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return { ok: false, errors: [`cannot write policy: ${err.message}`] };
  }
  reloadPolicy();

  return { ok: true, applied, version: doc.version };
}
