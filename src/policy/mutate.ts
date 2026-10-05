/** Host-side settings helper. The dashboard uses atomic revision activation directly. */

import { dump as dumpYaml, load as parseYamlDoc } from 'js-yaml';
import { parsePolicy, readPolicyText, saveStrategy, getPolicyHash } from './load';

export interface TradingSettingsUpdate {
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
  /** risk.maxDailyLossPct — fraction, e.g. 0.03 for 3% */
  maxDailyLossPct?: number;
  /** risk.maxGrossExposurePct — fraction of equity, e.g. 0.8 for 80% */
  maxGrossExposurePct?: number;
}

export type UpdateTradingSettingsResult =
  | { ok: true;  applied: string[]; version: number }
  | { ok: false; errors: string[] };

export function updateTradingSettings(changes: TradingSettingsUpdate): UpdateTradingSettingsResult {
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
  let watchlist: string[] = Array.isArray(doc.strategy.watchlist)
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
  const riskFields: Array<[keyof TradingSettingsUpdate & keyof typeof doc.risk, string]> = [
    ['maxPositions',      'risk.maxPositions'],
    ['positionSizePct',   'risk.positionSizePct'],
    ['stopLossAtrMult',   'risk.stopLossAtrMult'],
    ['maxDailyLossPct',   'risk.maxDailyLossPct'],
    ['maxGrossExposurePct', 'risk.maxGrossExposurePct'],
  ];
  for (const [field, label] of riskFields) {
    const v = changes[field as keyof TradingSettingsUpdate];
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

  try { saveStrategy(doc, getPolicyHash(), 'host-admin'); }
  catch (err: any) { return { ok: false, errors: [err.message] }; }

  return { ok: true, applied, version: doc.version };
}
