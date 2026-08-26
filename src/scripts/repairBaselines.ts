/**
 * Operator tool — narrow `sessionHigh` / `sessionLow` back to prices that actually traded.
 *
 * WHY THIS IS A SCRIPT AND NOT A STARTUP PASS
 *
 * `state.ts` says plainly: do not add a startup pass that narrows these figures against daily
 * bars. That warning is correct and this does not violate it. A daily series carries no bar for
 * the day in progress, so an automatic pass judges every position touched today against
 * yesterday's range and reads a genuine intraday extreme as impossible — on a live book it
 * wanted to erase UBER's real low on the day the position opened.
 *
 * Three things make this different:
 *
 *  1. FIVE-MINUTE BARS OVER AN EXPLICIT WINDOW, EVERY ONE OF THEM CARRYING TRADES.
 *     `fetchTradedRange` passes both bounds as instants, so today is in the series, and it
 *     requires a trade count per bar — Yahoo's intraday series, tried first, turned out to
 *     carry zero-volume bars whose extremes nobody dealt at, i.e. the same artifact.
 *  2. COVERAGE IS CHECKED, NOT ASSUMED. A window the vendor will not serve comes back short
 *     rather than as an error, so a series that does not reach back to the entry or forward to
 *     the last session is REFUSED, not used. Silence about a gap is how the old pass failed.
 *  3. AN OPERATOR RUNS IT, ON PURPOSE, AND SEES THE DIFF FIRST. Dry run is the default.
 *
 * The source of the bad numbers is fixed in `collect/priceSource.ts` + `features/compute.ts`:
 * a price the feed cannot corroborate no longer sets a record. This only cleans up the
 * records already poisoned before that gate existed, which nothing else can — they widen and
 * never narrow, so they have no path back on their own.
 *
 *   npx ts-node src/scripts/repairBaselines.ts                 # dry run, the default
 *   npx ts-node src/scripts/repairBaselines.ts --write         # apply
 *   npx ts-node src/scripts/repairBaselines.ts --write CRM UBER # only these symbols
 */

import { execSync } from 'child_process';
import fs from 'fs';
import { fetchTradedRange } from '../collect/priceSource';
import { canonicalSymbol } from '../core/symbols';
import { readFills } from '../review/fillsLedger';
import { getPositionSnapshot, getState, patchPositionSnapshot, type PositionSnapshot } from '../state/state';

const WRITE = process.argv.includes('--write');
const ONLY = process.argv.slice(2).filter((a) => !a.startsWith('-')).map(canonicalSymbol);

/**
 * How far outside the measured range a recorded figure may sit and still be left alone.
 *
 * Same reasoning as `RANGE_TOLERANCE_PCT` in `priceSource.ts`, and deliberately not shared with
 * it: that one guards a live reading, this one edits durable history, and the two should be free
 * to move apart. Erring loose is the right direction here — leaving a slightly-too-wide high in
 * place costs one stale reading, while shaving a real extreme rewrites the record of the trade.
 */
const TOLERANCE_PCT = 0.25;

/** A series must reach this close to the entry to be believed as covering it. */
const START_SLACK_MS = 30 * 60_000;
/**
 * ...and this close to now, or the most recent extreme may simply be missing.
 *
 * Generous because the honest end of the series is not "now": consolidated bars are embargoed
 * about fifteen minutes, and outside market hours the last bar is as old as the last session.
 * A day's slack tolerates a weekend-adjacent run while still catching a series that quietly
 * stops mid-hold — which is the failure that would let a real extreme be shaved off.
 */
const END_SLACK_MS = 26 * 60 * 60_000;

/** Crypto trades 24/7 on a different endpoint; the stocks bars API answers 400 for a pair. */
const CRYPTO = /[/-](USD|USDT|USDC)$|^(BTC|ETH|LTC|BCH|SOL|DOGE)USD$/i;

/**
 * When the position was opened, from the fills ledger, for a snapshot missing `openedAt`.
 *
 * Positions this system did not open have no `openedAt` — and CRM, the reason this script
 * exists, is one of them. Walked flat-to-flat from the venue's own fills, the same way
 * `review/ledger.ts` matches round trips: the answer wanted is the LAST time the book went
 * from flat to holding, because everything before that belongs to a trade already closed.
 */
function openedFromFills(symbol: string): string | null {
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

/** Is the live daemon holding this state in memory? Then the file is not the truth. */
function daemonPid(): string | null {
  try {
    const out = execSync('pgrep -f "ts-node src/daemon.ts" || true', { encoding: 'utf8' }).trim();
    return out ? out.split('\n')[0] : null;
  } catch {
    return null;
  }
}

interface Verdict {
  symbol: string;
  detail: string;
  patch?: Partial<PositionSnapshot>;
}

async function judge(snap: PositionSnapshot): Promise<Verdict> {
  const symbol = snap.symbol;
  const openedAt = snap.openedAt ?? openedFromFills(symbol);
  if (!openedAt) {
    return { symbol, detail: 'SKIP  no openedAt and no open position in the fills ledger — no window to measure' };
  }
  if (CRYPTO.test(symbol)) {
    return { symbol, detail: 'SKIP  crypto — the consolidated equity tape has nothing to say about a coin' };
  }
  if (snap.entryPrice == null || snap.sessionHigh == null || snap.sessionLow == null) {
    return { symbol, detail: 'SKIP  entry price or session extremes not recorded — nothing to narrow' };
  }

  let range;
  try {
    range = await fetchTradedRange(symbol, new Date(openedAt));
  } catch (err: any) {
    return { symbol, detail: `SKIP  no intraday bars: ${err?.response?.status ?? ''} ${err?.message ?? err}` };
  }

  const startGap = Date.parse(range.firstBarAt) - Date.parse(openedAt);
  const endGap = Date.now() - Date.parse(range.lastBarAt);
  if (startGap > START_SLACK_MS) {
    return {
      symbol,
      detail:
        `SKIP  bars start ${Math.round(startGap / 3_600_000)}h after the entry ` +
        `(${range.firstBarAt} vs opened ${openedAt}) — the early range is unmeasured`,
    };
  }
  if (endGap > END_SLACK_MS) {
    return {
      symbol,
      detail: `SKIP  bars stop ${Math.round(endGap / 3_600_000)}h ago (${range.lastBarAt}) — a recent extreme could be missing`,
    };
  }

  // Narrow only, and never inside the entry price: the extremes are seeded from entry at open,
  // so a high below it or a low above it would be a figure the position never actually had.
  const tol = TOLERANCE_PCT / 100;
  const ceiling = Math.max(snap.entryPrice, range.high * (1 + tol));
  const floor = Math.min(snap.entryPrice, range.low * (1 - tol));
  const newHigh = Math.min(snap.sessionHigh, ceiling);
  const newLow = Math.max(snap.sessionLow, floor);

  const coverage = `${range.bars} 5Min bars, traded ${range.low.toFixed(2)}–${range.high.toFixed(2)} since ${openedAt}`;
  const changes: string[] = [];
  const patch: Partial<PositionSnapshot> = {};
  if (newHigh < snap.sessionHigh) {
    patch.sessionHigh = newHigh;
    changes.push(`high ${snap.sessionHigh.toFixed(4)} -> ${newHigh.toFixed(4)} (${(((snap.sessionHigh - newHigh) / snap.sessionHigh) * 100).toFixed(2)}% phantom)`);
  }
  if (newLow > snap.sessionLow) {
    patch.sessionLow = newLow;
    changes.push(`low ${snap.sessionLow.toFixed(4)} -> ${newLow.toFixed(4)}`);
  }

  if (changes.length === 0) return { symbol, detail: `OK    recorded ${snap.sessionLow.toFixed(2)}–${snap.sessionHigh.toFixed(2)} is inside what traded — ${coverage}` };
  return { symbol, detail: `FIX   ${changes.join('; ')} — ${coverage}`, patch };
}

async function main(): Promise<void> {
  const pid = daemonPid();
  const snapshots = Object.values(getState().positionSnapshots).filter(
    (s) => ONLY.length === 0 || ONLY.includes(canonicalSymbol(s.symbol)),
  );

  const lines: string[] = [];
  const verdicts: Verdict[] = [];
  for (const snap of snapshots.sort((a, b) => a.symbol.localeCompare(b.symbol))) {
    const v = await judge(snap);
    verdicts.push(v);
    lines.push(`${v.symbol.padEnd(7)} ${v.detail}`);
  }

  const fixes = verdicts.filter((v) => v.patch);
  lines.push('');
  lines.push(`${verdicts.length} snapshot(s) examined, ${fixes.length} with a phantom extreme.`);

  if (!WRITE) {
    lines.push('Dry run — nothing written. Re-run with --write to apply.');
  } else if (pid) {
    // Refusing rather than warning: the daemon holds the whole state object in memory and
    // rewrites the file wholesale on its next save, so a write now is not merely racy, it is
    // guaranteed to be discarded — while the report would say it succeeded.
    lines.push(`REFUSED to write — the daemon is running as PID ${pid} and its in-memory state would overwrite this file.`);
    lines.push('Stop it, run this again with --write, then restart it.');
  } else if (fixes.length === 0) {
    lines.push('Nothing to write.');
  } else {
    for (const v of fixes) patchPositionSnapshot(v.symbol, v.patch!);
    // The state module debounces its write by 5s. Wait for the file itself to show the change
    // rather than reporting success off an in-memory object that may never reach disk.
    const deadline = Date.now() + 20_000;
    let confirmed = false;
    while (Date.now() < deadline && !confirmed) {
      await new Promise((r) => setTimeout(r, 1_000));
      try {
        const onDisk = JSON.parse(fs.readFileSync('data/state.json', 'utf8')).positionSnapshots ?? {};
        confirmed = fixes.every((v) => {
          const s = onDisk[canonicalSymbol(v.symbol)] ?? {};
          return Object.entries(v.patch!).every(([k, val]) => s[k] === val);
        });
      } catch {
        // mid-write; try again
      }
    }
    lines.push(
      confirmed
        ? `WROTE ${fixes.length} snapshot(s) to data/state.json — verified on disk.`
        : 'WRITE NOT CONFIRMED on disk after 20s — check data/state.json before restarting the daemon.',
    );
    for (const v of fixes) {
      const s = getPositionSnapshot(v.symbol);
      lines.push(`  ${v.symbol}: high ${s?.sessionHigh}, low ${s?.sessionLow}`);
    }
  }

  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}

void main();
