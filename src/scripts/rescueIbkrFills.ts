/**
 * One-shot rescue: pull whatever executions TWS still holds and append them to the fills
 * ledger, before the window closes.
 *
 * WHY THIS EXISTS: four IBKR executions on 2026-08-17 (three exits at ~10:52Z, one entry at
 * ~12:23Z, journal orderIds "1".."4") never reached `data/fills.jsonl` — the file is
 * byte-identical to the pre-switch Alpaca archive. Without them three round trips are
 * permanently unmeasurable and `get_scorecard` will report n=0 for this account.
 *
 * TWS SERVES THE CURRENT TRADING DAY ONLY. That is the whole reason this is urgent and also
 * the reason it will probably return nothing — the date has already rolled. The dry run is
 * free and settles the question definitively, which is worth more than the assumption.
 *
 * Usage:
 *   npx ts-node src/scripts/rescueIbkrFills.ts            # dry run, writes nothing
 *   npx ts-node src/scripts/rescueIbkrFills.ts --write     # append to the ledger
 */
import * as dotenv from 'dotenv';
dotenv.config();

// Must be set BEFORE the IBKRBroker import: the module reads it at load time into a
// module-level const. 30s so a slow Gateway handshake does not abort the query.
process.env.IBKR_API_TIMEOUT_MS = '30000';

import fs from 'fs';
import path from 'path';
import { IBKRBroker } from '../broker/IBKRBroker';
import { readFills, recordFills, FILLS_FILE } from '../review/fillsLedger';
import type { Fill } from '../broker/IBroker';

/** The orderIds the journal recorded for the four orphaned IBKR decisions. */
const EXPECTED_ORDER_IDS = ['1', '2', '3', '4'];

const WRITE = process.argv.includes('--write');

function journalOrphans(): { orderId: string; kind: string; symbol: string; at: string }[] {
  const file = path.join(process.cwd(), 'data', 'journal.jsonl');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: { orderId: string; kind: string; symbol: string; at: string }[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const r = JSON.parse(line);
      if (r?.orderId && EXPECTED_ORDER_IDS.includes(String(r.orderId))) {
        out.push({ orderId: String(r.orderId), kind: r.kind, symbol: r.symbol, at: r.at });
      }
    } catch {
      continue;
    }
  }
  return out;
}

function printFills(label: string, fills: Fill[]): void {
  console.log(`\n=== ${label} (${fills.length}) ===`);
  if (fills.length === 0) {
    console.log('  (none)');
    return;
  }
  console.log('  at                        symbol   side  qty     price      fee     orderId  permId    execId');
  console.log('  ' + '-'.repeat(110));
  for (const f of fills) {
    console.log(
      `  ${f.at.padEnd(25)} ${f.symbol.padEnd(8)} ${f.side.padEnd(5)} ` +
      `${String(f.qty).padStart(6)} ${f.price.toFixed(4).padStart(10)} ` +
      `${(f.fee != null ? f.fee.toFixed(2) : 'null').padStart(7)} ` +
      `${(f.orderId || '—').padStart(8)} ${(f.permId ?? '—').padStart(10)}  ${f.execId}`,
    );
  }
}

async function main() {
  console.log(`Mode: ${WRITE ? 'WRITE — will append to the ledger' : 'DRY RUN — writes nothing'}`);
  console.log(`Ledger: ${FILLS_FILE}`);

  const before = readFills();
  console.log(`Ledger currently holds ${before.length} fill(s); newest ${before.at(-1)?.at ?? '(empty)'}`);

  const orphans = journalOrphans();
  console.log(`\nJournal decisions carrying orderIds ${EXPECTED_ORDER_IDS.join(',')}: ${orphans.length}`);
  for (const o of orphans) {
    console.log(`  orderId ${o.orderId}  ${o.kind.padEnd(9)} ${o.symbol.padEnd(6)} ${o.at}`);
  }

  const broker = new IBKRBroker();

  // IB Gateway needs up to 5 s to complete the TWS handshake on a live account.
  await new Promise(r => setTimeout(r, 5000));

  try {
    const fills = await broker.getFills();
    printFills('EXECUTIONS TWS STILL HOLDS', fills);

    // The point of the exercise: is each orphaned decision now backed by a fill?
    console.log('\n=== ORPHAN CROSS-CHECK ===');
    let missing = 0;
    for (const id of EXPECTED_ORDER_IDS) {
      const matched = fills.filter(f => f.orderId === id);
      const j = orphans.find(o => o.orderId === id);
      const desc = j ? `${j.kind} ${j.symbol}` : '(no journal record)';
      if (matched.length > 0) {
        console.log(`  orderId ${id}  ${desc.padEnd(16)} MATCHED  ${matched.length} fill(s), ` +
          `${matched.map(f => `${f.symbol} ${f.side} ${f.qty}@${f.price}`).join('; ')}`);
      } else {
        missing++;
        console.log(`  orderId ${id}  ${desc.padEnd(16)} MISSING  — no execution returned by TWS`);
      }
    }

    if (missing > 0) {
      console.log(
        `\nALARM: ${missing}/${EXPECTED_ORDER_IDS.length} orphaned orderIds have no execution.\n` +
        `  TWS serves the current trading day only; if the date has rolled since these traded\n` +
        `  they are gone for good. The journal keeps the decisions and rationales, but the\n` +
        `  round trips are permanently unmeasurable and get_scorecard will honestly say n=0.`,
      );
    }

    if (WRITE) {
      const added = recordFills(fills);
      console.log(`\nWrote ${added} new fill(s) to the ledger (${fills.length} returned, rest already known).`);
      console.log(`Ledger now holds ${readFills().length} fill(s).`);
    } else if (fills.length > 0) {
      console.log('\nDry run — re-run with --write to append these to the ledger.');
    }
  } finally {
    broker.disconnect();
  }

  // The IB socket keeps the event loop alive even after disconnect().
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err?.error?.message ?? err?.message ?? err);
  process.exit(1);
});
