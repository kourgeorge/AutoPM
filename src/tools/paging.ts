import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { appendRecord, isEphemeralStorage, readRecord, recordDay, saveRecord } from '../core/storage';
import { DATA_DIR } from '../core/paths';
import { writeFileAtomic } from '../core/fsAtomic';
import { agentContext } from '../core/agentContext';
import { sameSymbol } from '../core/symbols';
import { REQUEST_CHAR_LIMIT } from '../core/modelBudget';

type Snapshot = { kind: string; data: Record<string, any> };
/** What a receipt keeps: where the snapshot file is, not the data. `file` is relative to DATA_DIR/db. */
type SnapshotPointer = { kind: string; file: string; bytes: number };

const DB_DIR = path.join(DATA_DIR, 'db');
const ephemeralFiles = new Map<string, string>();   // the replay harness never writes the operator's data

/**
 * Each snapshot is its own file (temp + rename, so never half-written); receipts stay small.
 * It sits beside its receipt: days/<day>/snapshots/. Older pointers to snapshots/ still load.
 */
function writeSnapshotFile(id: string, snapshot: Snapshot): SnapshotPointer {
  const dir = `days/${recordDay('tool-calls', id)}/snapshots`;
  const file = `${dir}/${id.replace(/[^\w.-]/g, '_')}.json`, text = JSON.stringify(snapshot);
  if (isEphemeralStorage()) ephemeralFiles.set(file, text);
  else {
    fs.mkdirSync(path.join(DB_DIR, dir), { recursive: true, mode: 0o700 });
    writeFileAtomic(path.join(DB_DIR, file), text);
  }
  return { kind: snapshot.kind, file, bytes: Buffer.byteLength(text) };
}

/** A receipt's snapshot: the old inline shape ({kind, data}) or a pointer to its file. */
function loadSnapshot(stored: Snapshot | SnapshotPointer): Snapshot | undefined {
  if ('data' in stored) return stored;
  if (typeof stored.file !== 'string' || stored.file.includes('..')) return undefined;
  try {
    const text = isEphemeralStorage() ? ephemeralFiles.get(stored.file) : fs.readFileSync(path.join(DB_DIR, stored.file), 'utf8');
    return text === undefined ? undefined : JSON.parse(text) as Snapshot;
  } catch { return undefined; }
}

/** Write the full observation to its own file; the tool call's receipt points at it and its id is the snapshotId. */
function saveSnapshot(snapshot: Snapshot): string {
  const call = agentContext.getStore()?.toolCallId;
  if (call) {
    const pointer = writeSnapshotFile(call, snapshot);
    saveRecord('tool-calls', call, { ...readRecord<object>('tool-calls', call), snapshot: pointer });
    return call;
  }
  const id = 'snapshot-' + crypto.randomUUID(), at = new Date().toISOString();
  appendRecord('tool-calls', id, at, { name: snapshot.kind, snapshot: writeSnapshotFile(id, snapshot), startedAt: at, finishedAt: at });
  return id;
}

type Receipt = { name?: string; input?: { snapshotId?: unknown }; snapshot?: Snapshot | SnapshotPointer };

/**
 * The receipt holding the snapshot. Only the first call stores it; a later page's receipt
 * points back to it through its own input, and models often pass that later receipt id, so follow it.
 */
function findSnapshot(kind: string, start: string): { id: string; snapshot: Snapshot } | undefined {
  let id = start;
  for (let hop = 0; hop < 20; hop++) {
    const row = readRecord<Receipt>('tool-calls', id);
    if (row?.snapshot) {
      if (row.snapshot.kind !== kind) return undefined;
      const snapshot = loadSnapshot(row.snapshot);
      return snapshot ? { id, snapshot } : undefined;
    }
    if (row?.name !== kind || typeof row.input?.snapshotId !== 'string') return undefined;
    id = row.input.snapshotId;
  }
  return undefined;
}

/** Default size of one page, in characters of the whole page result. */
export const PAGE_CHAR_BUDGET = 9000;
/**
 * Page size for wide tables the trader reads whole (watchlist scan, market context). Each call
 * re-sends the conversation, so few big pages are far cheaper than many small ones; a sixth of
 * the request limit leaves room for the instructions, tools and the rest of the turn.
 */
export const LARGE_PAGE_CHAR_BUDGET = Math.floor(REQUEST_CHAR_LIMIT / 6);
/** Most rows one large page may hold. */
export const LARGE_PAGE_MAX_ROWS = 200;

export interface PageOptions {
  /** Most characters a page may hold (a page always holds at least one row). */
  budget?: number;
  /** Rows per page when the caller passes no limit. */
  defaultLimit?: number;
  /** Largest limit the caller may pass. */
  maxLimit?: number;
  /** Shapes each row for this page (for example a compact view). Rows are dropped whole, never shortened. */
  project?: (row: any) => any;
}

/** Stable pages from one immutable observation, with complete rows and explicit omissions. */
export function recordPage(kind: string, data: Record<string, any>, key: string, input: Record<string, unknown>, options: PageOptions = {}) {
  const budget = options.budget ?? PAGE_CHAR_BUDGET, maxLimit = options.maxLimit ?? 50, project = options.project ?? ((row: any) => row);
  const found = input.snapshotId ? findSnapshot(kind, String(input.snapshotId)) : undefined;
  if (input.snapshotId && !found) throw new Error(`Unknown snapshot for this tool: ${input.snapshotId}. Copy snapshotId exactly from the first ${kind} result, or call ${kind} without snapshotId to start a fresh snapshot.`);
  const old = found?.snapshot;
  const full = old?.data ?? data;
  if (input.symbol && full.symbol && !sameSymbol(String(input.symbol), String(full.symbol))) throw new Error('Snapshot belongs to a different symbol');
  const id = found ? found.id : saveSnapshot({ kind, data: full });
  const all = full[key] as any[];
  const offset = Number(input.offset ?? 0), limit = Number(input.limit ?? options.defaultLimit ?? 20);
  if (!Array.isArray(all) || !Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) throw new Error('Invalid rows or page limit');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > all.length) throw new Error('Offset is outside the snapshot');
  const out = { ...full, [key]: [] as any[], snapshotId: id, offset, total: all.length, nextOffset: null as number | null };
  // Size grows row by row: measure the empty page once (with room for any nextOffset), then add each row and its comma.
  let size = JSON.stringify(out).length + String(all.length).length;
  for (let i = offset; i < all.length && i < offset + limit; i++) {
    const row = project(all[i]), rowSize = JSON.stringify(row).length + (out[key].length ? 1 : 0);
    if (size + rowSize > budget && out[key].length) break;
    out[key].push(row); size += rowSize;
  }
  out.nextOffset = offset + out[key].length < all.length ? offset + out[key].length : null;
  return out;
}
