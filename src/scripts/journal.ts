/**
 * Journal review.
 *
 * Nothing else reads `data/journal.jsonl`. Without a review layer a schema mistake at a
 * write site is completely silent — the record lands, the day looks fine, and the field
 * that was supposed to answer "why" is `null` forever. So this is both the reader and
 * the schema check, and it exists before the first live entry rather than after.
 *
 * `readDecisions` deliberately SKIPS unparseable lines, so this reads the raw file
 * itself: a torn line is exactly the kind of thing worth being told about once, and the
 * function whose job is to survive one cannot also report it.
 *
 *   npm run journal            # last 20
 *   npm run journal -- 100     # last 100
 *   npm run journal -- 20 NVDA # last 20 for one symbol
 */

import fs from 'fs';
import { canonicalSymbol } from '../core/symbols';
import { JOURNAL_FILE } from '../journal/journal';
import type { DecisionRecord } from '../journal/types';

const KINDS = ['entry', 'exit', 'hold', 'veto', 'rejected'];
const ACTORS = ['trader', 'guard', 'broker'];

/**
 * Fields that must carry a value for a given kind, beyond the ones every record needs.
 *
 * `entry` requires `intendedStop` because `policy.immutable.requireStopOnEntry` is the
 * one rule the system claims is inviolable, and a journal that cannot show the stop
 * cannot prove it was honoured.
 */
const REQUIRED_BY_KIND: Record<string, (keyof DecisionRecord)[]> = {
  entry:    ['symbol', 'qty', 'price', 'intendedStop', 'intendedTarget'],
  exit:     ['symbol', 'qty', 'price'],
  veto:     ['symbol', 'vetoRule'],
  rejected: ['symbol', 'venueMessage'],
  hold:     [],
};

function checkRecord(r: DecisionRecord, lineNo: number): string[] {
  const problems: string[] = [];
  const bad = (msg: string) => problems.push(`line ${lineNo}: ${msg}`);

  for (const field of ['id', 'at', 'kind', 'actor', 'rationale'] as const) {
    if (!r[field]) bad(`missing ${field}`);
  }
  if (typeof r.policyVersion !== 'number') bad('policyVersion is not a number');
  if (!KINDS.includes(r.kind)) bad(`unknown kind ${JSON.stringify(r.kind)}`);
  if (!ACTORS.includes(r.actor)) bad(`unknown actor ${JSON.stringify(r.actor)}`);

  for (const field of REQUIRED_BY_KIND[r.kind] ?? []) {
    if (r[field] == null) bad(`${r.kind} record has null ${field}`);
  }

  // `executed` is the field a reviewer filters on to separate what happened from what
  // was only intended, so a veto or a rejection claiming execution is a real defect.
  if ((r.kind === 'veto' || r.kind === 'rejected') && r.executed) {
    bad(`${r.kind} record is marked executed`);
  }
  if ((r.kind === 'entry' || r.kind === 'exit') && !r.executed) {
    bad(`${r.kind} record is not marked executed`);
  }

  return problems;
}

function main(): void {
  const [limitArg, symbolArg] = process.argv.slice(2);
  const limit = limitArg ? Number(limitArg) : 20;
  const symbol = symbolArg?.toUpperCase();

  let raw: string;
  try {
    raw = fs.readFileSync(JOURNAL_FILE, 'utf8');
  } catch {
    console.log(`No journal yet at ${JOURNAL_FILE} — nothing has been decided.`);
    return;
  }

  const problems: string[] = [];
  const records: DecisionRecord[] = [];

  raw.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    try {
      const rec = JSON.parse(line) as DecisionRecord;
      problems.push(...checkRecord(rec, i + 1));
      records.push(rec);
    } catch {
      problems.push(`line ${i + 1}: unparseable — ${line.slice(0, 60)}…`);
    }
  });

  // Canonical, so `btc/usd` on the command line finds the `BTCUSD` records the venue wrote.
  const wanted = symbol ? canonicalSymbol(symbol) : null;
  const shown = (wanted
    ? records.filter((r) => r.symbol != null && canonicalSymbol(r.symbol) === wanted)
    : records
  ).slice(-limit);

  for (const r of shown) {
    const qty = r.qty != null && r.price != null ? ` ${r.qty}sh @ $${r.price.toFixed(2)}` : '';
    const pnl = r.pnl != null ? ` P&L $${r.pnl.toFixed(2)}` : '';
    const why = r.vetoRule ? ` [${r.vetoRule}]` : r.venueMessage ? ` [${r.venueMessage}]` : '';
    const evt = r.triggerEventId ? ` <- ${r.triggerEventId}` : '';
    console.log(
      `${r.at.slice(0, 19)} ${r.kind.toUpperCase().padEnd(8)} ${(r.symbol ?? '—').padEnd(6)}` +
      `${qty}${pnl}${why} — ${r.rationale}${evt}`,
    );
  }

  console.log('');
  console.log(`${records.length} record(s) total, ${shown.length} shown.`);

  if (problems.length > 0) {
    console.error(`FAIL — ${problems.length} schema problem(s):`);
    problems.forEach((p) => console.error(`  - ${p}`));
    process.exit(1);
  }
  console.log('PASS — every record parses and carries the fields its kind requires.');
}

main();
