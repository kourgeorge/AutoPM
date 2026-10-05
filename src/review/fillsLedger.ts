/**
 * L5 — the fills ledger: what the venues actually executed.
 *
 * The journal next door records what this system DECIDED and why. This records what it
 * GOT. Both are needed and neither substitutes for the other: rationale, holds, guard
 * vetoes and venue rejections are invisible at the broker, while fill prices, partial
 * fills and fees are invisible to a decision record written before the order left.
 *
 * WHY IT IS PERSISTED AT ALL, given both brokers can be asked:
 * TWS serves executions for the CURRENT TRADING DAY ONLY. Any review that reaches back
 * further than one session cannot be built on a broker query, so the broker is demoted to
 * what it can actually be — a tap on recent activity — and the durable record is ours.
 * A useful consequence: the review path touches no network and cannot be rate-limited,
 * throttled or half-answered while it is computing a statistic.
 *
 * Same write discipline as `journal.ts`, for the same reason: this holds what happened, so
 * a record sitting in a debounce timer when the process dies is worthless in exactly the
 * case it was written for.
 */

import { appendRecord, readRecords, importJsonLines, transaction } from '../core/storage';
import path from 'path';
import { logger } from '../core/logger';
import type { Fill } from '../broker/IBroker';
import { canonicalSymbol } from '../core/symbols';
import { DATA_DIR, ensureDataDir } from '../core/paths';

export const FILLS_FILE = path.join(DATA_DIR, 'fills.jsonl');

let _ephemeral = false;

/** Stop writing to disk, permanently for this process. Mirrors `useEphemeralJournal`. */
export function useEphemeralFillsLedger(): void {
  _ephemeral = true;
}

/**
 * The identity of a fill, with IBKR's correction convention resolved.
 *
 * IBKR does not retract a fill it got wrong; it re-reports it with an execId differing only
 * in the digits after the final period — `…7d3.01` superseded by `…7d3.02`. Keyed naively
 * on execId those are two fills, and the position doubles. So the key is the part before
 * that final period and the suffix is a revision number.
 *
 * Alpaca ids (`20260813152936446::2e92a38b-…`) contain no period, which this rule reads as
 * revision 0 of a base that is the whole id — the correct answer for a venue that never
 * corrects.
 */
function identify(execId: string): { base: string; revision: number } {
  const m = /^(.*)\.(\d+)$/.exec(execId);
  return m ? { base: m[1], revision: parseInt(m[2], 10) } : { base: execId, revision: 0 };
}

/**
 * Every fill on record, oldest-first, corrections applied and duplicates removed.
 *
 * Deduplication happens on READ, not on write. The file is therefore append-only in the
 * strict sense — a correction is a new line, and the superseded line stays visible to
 * anyone reading the raw file to find out what the venue said and when. Reconciliation
 * would otherwise have to rewrite history in place, which is how an append-only log
 * quietly becomes a mutable one.
 *
 * An unparseable line is skipped, not thrown on: a process killed mid-append leaves a torn
 * final line, and that must cost the last fill, not the file.
 */
export function readFills(opts: { symbol?: string; since?: Date } = {}): Fill[] {
  if (_ephemeral) return [];
  importJsonLines('fill', FILLS_FILE);
  const byBase = new Map<string, { revision: number; order: number; fill: Fill }>();
  let order = 0;
  for (const fill of readRecords<Fill>('fill')) {
    const { base, revision } = identify(fill.execId);
    const existing = byBase.get(base);
    // `>=` and not `>`: a re-append of the same revision is the ordinary case (two
    // reconciliations overlapping), and the later line is the more recent reading of it.
    if (!existing || revision >= existing.revision) {
      // The original arrival position is kept, so a correction does not reorder the day.
      byBase.set(base, { revision, order: existing?.order ?? order, fill });
    }
    order++;
  }

  let fills = [...byBase.values()]
    .sort((a, b) => a.fill.at.localeCompare(b.fill.at) || a.order - b.order)
    .map(e => e.fill);

  // Canonical: an Alpaca crypto fill is recorded as `BTCUSD` while every caller asks with
  // the spelling it placed the order under, `BTC/USD`, and `===` answered "no fills".
  if (opts.symbol) {
    const wanted = canonicalSymbol(opts.symbol);
    fills = fills.filter(f => canonicalSymbol(f.symbol) === wanted);
  }
  if (opts.since) {
    const cutoff = opts.since.toISOString();
    fills = fills.filter(f => f.at >= cutoff);
  }
  return fills;
}

/**
 * Append fills that are not already on record. Returns how many were new.
 *
 * Idempotent by design, because every caller re-reads an overlapping window: the
 * reconciler cannot ask a broker for "fills since exactly the last one I saw" — Alpaca's
 * `after` is coarse and IBKR has no usable filter at all — so it over-fetches on purpose
 * and this is what makes that free.
 *
 * A correction IS appended even though its base is already present, and is what read-time
 * dedup then resolves.
 *
 * A write failure is logged and swallowed. The ledger is a witness, not a participant.
 */
export function recordFills(fills: Fill[]): number {
  if (fills.length === 0) return 0;

  const known = new Map<string, number>();
  for (const f of readFills()) {
    const { base, revision } = identify(f.execId);
    known.set(base, revision);
  }

  const fresh: Fill[] = [];
  for (const f of fills) {
    const { base, revision } = identify(f.execId);
    const seen = known.get(base);
    if (seen != null && revision <= seen) continue;
    known.set(base, revision);
    fresh.push(f);
  }
  if (fresh.length === 0) return 0;

  if (!_ephemeral) {
    transaction(() => {
      for (const fill of fresh) appendRecord('fill', fill.execId, fill.at, fill);
    });
  }

  return fresh.length;
}

/**
 * When the currently open position in `symbol` was opened, from the fills ledger — or null
 * when the ledger shows no open position (none of its fills, or it ends flat).
 *
 * For a snapshot missing `openedAt`: positions this system did not open have none, and neither
 * does a snapshot `annotate_position` creates for a position whose record was lost. Walked
 * flat-to-flat from the venue's own fills, the same way `review/ledger.ts` matches round trips:
 * the answer wanted is the LAST time the book went from flat to holding, because everything
 * before that belongs to a trade already closed.
 */
export function openedAtFromFills(symbol: string): string | null {
  const fills = readFills({ symbol }).sort((a, b) => a.at.localeCompare(b.at));
  let qty = 0;
  let openedAt: string | null = null;
  for (const f of fills) {
    const before = qty;
    qty += f.side === 'buy' ? f.qty : -f.qty;
    if (before <= 0 && qty > 0) openedAt = f.at;
    if (qty <= 0) openedAt = null;
  }
  return openedAt;
}
