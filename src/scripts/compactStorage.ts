/**
 * Rewrite the account's record files with only the live version of each record.
 *
 * Every save appends a whole new copy of its record and a delete appends a tombstone; nothing is
 * ever removed, so files only grow. This keeps the last line per id, drops deleted ids, and keeps
 * seq order — exactly what `storage.open()` rebuilds in memory, so nothing a reader sees changes.
 *
 * Optionally (`--drop-failed-trails`) it also removes the journal rows of failed trailing-stop
 * raises, keeping the first per symbol and failure reason so each episode stays on record.
 * Those rows changed nothing at the broker; before the back-off (1e7e684) one was written per
 * tick, 6,044 of them on 2026-11-02..04.
 *
 * The engine must be stopped (its lock is checked). Each file is written beside the original,
 * re-read and compared to what was meant, then swapped in; the original is kept as
 * `<file>.pre-compact` until `--delete-originals`.
 *
 *   npx ts-node src/scripts/compactStorage.ts [--drop-failed-trails] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DATA_DIR } from '../core/paths';

interface Line { seq: number; id: string; at: string; value?: any; deleted?: boolean }

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const DROP_TRAILS = args.has('--drop-failed-trails');
const DB = path.join(DATA_DIR, 'db');

async function liveRows(file: string): Promise<{ rows: Map<string, { line: string; seq: number }>; lines: number; bytes: number }> {
  const rows = new Map<string, { line: string; seq: number }>();
  let lines = 0, bytes = 0;
  for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    lines++; bytes += Buffer.byteLength(line) + 1;
    const e = JSON.parse(line) as Line;
    if (e.deleted) rows.delete(e.id); else rows.set(e.id, { line, seq: e.seq });
  }
  return { rows, lines, bytes };
}

/** The failed trail rows to drop: all but the first per symbol and failure reason. */
function failedTrailsToDrop(rows: Map<string, { line: string; seq: number }>): Set<string> {
  const seen = new Set<string>(), drop = new Set<string>();
  const sorted = [...rows.entries()].sort((a, b) => a[1].seq - b[1].seq);
  for (const [id, { line }] of sorted) {
    if (!id.startsWith('trail-')) continue;
    const v = (JSON.parse(line) as Line).value;
    if (v?.kind !== 'adjustment' || v.actor !== 'guard' || v.orderStatus !== 'failed') continue;
    const key = `${v.symbol}|${v.venueStopMissing ?? ''}`;
    if (seen.has(key)) drop.add(id); else seen.add(key);
  }
  return drop;
}

async function compact(name: string): Promise<void> {
  const file = path.join(DB, name);
  const { rows, lines, bytes } = await liveRows(file);
  const drop = DROP_TRAILS && name === 'journal.jsonl' ? failedTrailsToDrop(rows) : new Set<string>();
  const kept = [...rows.entries()].filter(([id]) => !drop.has(id)).sort((a, b) => a[1].seq - b[1].seq);
  const saved = bytes - kept.reduce((n, [, r]) => n + Buffer.byteLength(r.line) + 1, 0);
  console.log(`${name.padEnd(24)} ${String(lines).padStart(7)} lines → ${String(kept.length).padStart(7)}`
    + `  (${(saved / 1e6).toFixed(1)} MB smaller${drop.size ? `, ${drop.size} failed trail rows dropped` : ''})`);
  if (DRY || (lines === kept.length && !drop.size)) return;

  const tmp = file + '.compact-tmp';
  // Written in chunks: the largest file is past Node's single-string limit.
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { for (const [, r] of kept) fs.writeSync(fd, r.line + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }

  const check = await liveRows(tmp);
  if (check.rows.size !== kept.length || check.lines !== kept.length) throw new Error(`${name}: rewritten file does not match (${check.rows.size} rows)`);
  for (const [id, r] of kept) if (check.rows.get(id)?.line !== r.line) throw new Error(`${name}: record ${id} differs after rewrite`);

  fs.renameSync(file, file + '.pre-compact');
  fs.renameSync(tmp, file);
}

async function main(): Promise<void> {
  if (fs.existsSync(path.join(DATA_DIR, '.engine-lock'))) throw new Error(`The engine holds ${DATA_DIR}/.engine-lock; stop it first.`);
  if (args.has('--delete-originals')) {
    for (const f of fs.readdirSync(DB).filter(f => f.endsWith('.pre-compact'))) fs.rmSync(path.join(DB, f));
    console.log('Removed the .pre-compact originals.');
    return;
  }
  console.log(`${DRY ? 'Dry run on' : 'Compacting'} ${DB}`);
  for (const name of fs.readdirSync(DB).filter(f => f.endsWith('.jsonl')).sort()) await compact(name);
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
