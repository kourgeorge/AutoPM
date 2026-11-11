import fs from 'fs';
import path from 'path';
import {
  dayFolderPath, dayRecords, deleteDayRecords, isEphemeralStorage, keepRecord, keptRecord, listDayFolders,
  listRecords, readValue, saveValue, type KeptRecord,
} from '../core/storage';
import { DATA_DIR } from '../core/paths';
import { etNow } from '../core/time';
import { logger } from '../core/logger';
import { readDecisionsNewestFirst } from './journal';

/**
 * Old day folders (db/days/<day>/) are cleaned up once a day: scan snapshot files after
 * `snapshotDays`, the tool-call receipts file after `receiptDays`.
 *
 * A receipt a recorded decision cites as evidence is never lost: before its day is cleaned it is
 * copied to db/evidence/<id>.json (with its snapshot written in), and lookups by id find it there.
 * "Cited" means: a journal row's observationIds, entry plan, review and thesis evidence; an
 * order's observationIds and thesis; every saved candidate/position/research review and the
 * evidence, snapshot and entry plan it names; and, for each kept receipt, the receipts it points
 * to in turn (a later scan page points to the first page, which holds the snapshot).
 *
 * The journal, fills, orders, lessons and the old single tool-calls.jsonl are only read, never changed.
 */

export interface RetentionSettings {
  /** Days a scan snapshot file is kept. */
  snapshotDays: number;
  /** Days a day's tool-call receipts are kept. */
  receiptDays: number;
}
export const DEFAULT_RETENTION: RetentionSettings = { snapshotDays: 2, receiptDays: 90 };
const LIMITS = { snapshotDays: [1, 365], receiptDays: [7, 3650] } as const;

function validate(input: Partial<RetentionSettings>): RetentionSettings {
  const out = { ...DEFAULT_RETENTION };
  for (const key of ['snapshotDays', 'receiptDays'] as const) {
    if (input[key] === undefined) continue;
    const value = input[key], [min, max] = LIMITS[key];
    if (!Number.isSafeInteger(value) || value! < min || value! > max) {
      throw new Error(`${key === 'snapshotDays' ? 'Days to keep snapshot files' : 'Days to keep tool-call receipts'} must be a whole number from ${min} to ${max}`);
    }
    out[key] = value!;
  }
  return out;
}

export function retentionSettings(): RetentionSettings {
  try { return validate(readValue<Partial<RetentionSettings>>('retention') ?? {}); }
  catch { return { ...DEFAULT_RETENTION }; }
}
export function saveRetentionSettings(input: Partial<RetentionSettings>): RetentionSettings {
  const valid = validate({ ...retentionSettings(), ...input });
  saveValue('retention', valid);
  return valid;
}

const REVIEW_TOOLS = new Set(['record_position_review', 'record_candidate_review', 'record_research_review']);
const RECEIPTS = 'tool-calls';
type Pointer = { kind?: string; file?: string; data?: unknown };
interface Receipt { name?: string; input?: any; result?: string; snapshot?: Pointer }

const parse = (text: unknown): any => { try { return JSON.parse(String(text ?? '')); } catch { return undefined; } };

/** Evidence ids named by a decision-like object: its own fields and its thesis. */
function idsIn(o: any): string[] {
  if (!o || typeof o !== 'object') return [];
  const out: unknown[] = [o.snapshotId, o.evidenceId, o.entryPlanId, o.planId, o.entryPlan?.evidenceId,
    ...(Array.isArray(o.evidenceIds) ? o.evidenceIds : []), ...(Array.isArray(o.observationIds) ? o.observationIds : [])];
  for (const p of [...(o.thesis?.premises ?? []), ...(o.thesis?.sharedDrivers ?? [])]) if (Array.isArray(p?.evidenceIds)) out.push(...p.evidenceIds);
  return out.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** A review id is `review-<receipt id>` or `candidate-<receipt id>`, or the receipt id itself. */
const reviewReceiptIds = (id: string) => [id, id.replace(/^(review|candidate|research)-/, '')];

interface ScannedReceipt { refs: string[]; day: string; snapshotFile?: string; review?: string }

/** Why each receipt must be kept, keyed by receipt id. */
function citedReceipts(receipts: Map<string, ScannedReceipt>): Map<string, string> {
  const why = new Map<string, string>();
  const cite = (id: string, reason: string) => { if (!why.has(id)) why.set(id, reason); };
  for (const d of readDecisionsNewestFirst()) {
    const label = `${d.kind} decision ${d.id}`;
    for (const id of d.observationIds ?? []) cite(id, `cited by ${label}`);
    if (d.entryPlan?.evidenceId) cite(d.entryPlan.evidenceId, `entry plan of ${label}`);
    for (const id of idsIn({ thesis: d.thesis })) cite(id, `thesis evidence of ${label}`);
    if (d.reviewId) for (const id of reviewReceiptIds(d.reviewId)) cite(id, `review behind ${label}`);
  }
  for (const { id: orderId, value } of listRecords<{ params?: any }>('orders')) {
    for (const id of idsIn(value?.params)) cite(id, `cited by order ${orderId}`);
  }
  // Saved reviews are decisions too: the review itself, and what it names.
  for (const [id, r] of receipts) if (r.review) cite(id, `saved ${r.review}`);
  // Follow what each kept receipt points to, until nothing new turns up.
  const queue = [...why.keys()];
  while (queue.length) {
    const id = queue.shift()!, r = receipts.get(id);
    for (const ref of r?.refs ?? []) {
      if (why.has(ref)) continue;
      why.set(ref, `${why.get(id)} (through ${id})`);
      queue.push(ref);
    }
  }
  return why;
}

export interface CleanupReport {
  snapshotsDeleted: Array<{ day: string; files: number }>;
  receiptsDeleted: Array<{ day: string; receipts: number }>;
  kept: Array<{ id: string; day: string; reason: string }>;
  line: string;
}

const dayAge = (today: string, day: string) => Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(day + 'T00:00:00Z')) / 86_400_000);

/**
 * Delete what is past its limit, keeping cited receipts in db/evidence/. Safe to run any time:
 * a second run finds nothing left to delete and writes nothing.
 */
export function cleanupDayFolders(now = new Date(), settings = retentionSettings()): CleanupReport {
  const report: CleanupReport = { snapshotsDeleted: [], receiptsDeleted: [], kept: [], line: '' };
  if (isEphemeralStorage()) { report.line = '[Cleanup] skipped: replay storage'; return report; }
  const today = etNow(now).date, days = listDayFolders();
  const snapshotLimit = Math.min(settings.snapshotDays, settings.receiptDays);
  const snapshotDir = (day: string) => path.join(dayFolderPath(day), 'snapshots');
  const receiptsFile = (day: string) => path.join(dayFolderPath(day), RECEIPTS + '.jsonl');
  const snapshotDue = days.filter(d => dayAge(today, d) >= snapshotLimit && fs.existsSync(snapshotDir(d)));
  const receiptDue = days.filter(d => dayAge(today, d) >= settings.receiptDays && fs.existsSync(receiptsFile(d)));
  if (!snapshotDue.length && !receiptDue.length) {
    report.line = `[Cleanup] nothing to delete (snapshots kept ${settings.snapshotDays} days, receipts ${settings.receiptDays} days)`;
    logger.info(report.line);
    return report;
  }

  // Every receipt in the day folders: what it points to, its day and its snapshot file. Reviews
  // in recent days can cite evidence in an old day, so all days are read, not only the due ones.
  const receipts = new Map<string, ScannedReceipt>();
  for (const day of days) for (const { id, value } of dayRecords<Receipt>(RECEIPTS, day)) {
    const result = parse(value?.result);
    const review = value?.name && REVIEW_TOOLS.has(value.name) && result?.ok && result.review ? result.review : undefined;
    receipts.set(id, { day, refs: [...idsIn(value?.input), ...idsIn(review)],
      snapshotFile: typeof value?.snapshot?.file === 'string' ? value.snapshot.file : undefined,
      review: review ? `${value!.name} ${review.id ?? id}` : undefined });
  }
  const why = citedReceipts(receipts);

  const keep = (id: string, day: string, value: Receipt, seq: number, at: string, withSnapshot: boolean) => {
    if (keptRecord(RECEIPTS, id)) return;
    let saved: Receipt = value;
    const file = value.snapshot?.file;
    if (withSnapshot && typeof file === 'string' && !file.includes('..')) {
      try { saved = { ...value, snapshot: JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'db', file), 'utf8')) }; }
      catch { /* the snapshot is already gone; keep the receipt as it is */ }
    }
    keepRecord(RECEIPTS, { id, seq, at, value: saved });
    report.kept.push({ id, day, reason: why.get(id)! });
  };

  for (const day of snapshotDue) {
    const dir = snapshotDir(day), prefix = `days/${day}/snapshots/`;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
    const byDay = new Map<string, Map<string, KeptRecord<Receipt>>>();
    for (const [id, r] of receipts) {
      if (!why.has(id) || !r.snapshotFile?.startsWith(prefix)) continue;
      if (!byDay.has(r.day)) byDay.set(r.day, new Map(dayRecords<Receipt>(RECEIPTS, r.day).map(x => [x.id, x])));
      const row = byDay.get(r.day)!.get(id);
      if (row) keep(id, r.day, row.value, row.seq, row.at, true);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    report.snapshotsDeleted.push({ day, files });
  }
  for (const day of receiptDue) {
    const rows = dayRecords<Receipt>(RECEIPTS, day);
    for (const row of rows) if (why.has(row.id)) keep(row.id, day, row.value, row.seq, row.at, true);
    deleteDayRecords(RECEIPTS, day);
    report.receiptsDeleted.push({ day, receipts: rows.length });
    try { fs.rmdirSync(dayFolderPath(day)); } catch { /* something else still lives in it */ }
  }

  const parts = [
    report.snapshotsDeleted.length ? `snapshots of ${report.snapshotsDeleted.map(s => `${s.day} (${s.files} files)`).join(', ')}` : '',
    report.receiptsDeleted.length ? `receipts of ${report.receiptsDeleted.map(s => `${s.day} (${s.receipts})`).join(', ')}` : '',
  ].filter(Boolean);
  const shown = report.kept.slice(0, 10).map(k => `${k.id} (${k.reason})`);
  const more = report.kept.length > shown.length ? `, and ${report.kept.length - shown.length} more` : '';
  report.line = `[Cleanup] deleted ${parts.join('; ')}; kept ${report.kept.length} in db/evidence`
    + (shown.length ? `: ${shown.join('; ')}${more}` : '');
  logger.info(report.line);
  return report;
}

let timer: ReturnType<typeof setInterval> | undefined;
let first: ReturnType<typeof setTimeout> | undefined;
let lastRunDay = '';
/** Run the cleanup soon after start, then once per US Eastern day (checked hourly). */
export function startRetention(): void {
  if (timer) return;
  const tick = () => {
    const day = etNow().date;
    if (day === lastRunDay) return;
    lastRunDay = day;
    try { cleanupDayFolders(); }
    catch (err: any) { logger.warn(`[Cleanup] failed: ${err?.message ?? err}`); }
  };
  first = setTimeout(tick, 60_000);
  first.unref();
  timer = setInterval(tick, 60 * 60_000);
  timer.unref();
}
export function stopRetention(): void {
  clearTimeout(first);
  clearInterval(timer);
  timer = first = undefined;
}
