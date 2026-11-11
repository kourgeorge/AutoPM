import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { appendRecord, isEphemeralStorage, readRecord, saveRecord } from '../core/storage';
import { DATA_DIR } from '../core/paths';
import { writeFileAtomic } from '../core/fsAtomic';
import { agentContext } from '../core/agentContext';
import { sameSymbol } from '../core/symbols';

type Snapshot = { kind: string; data: Record<string, any> };
/** What a receipt keeps: where the snapshot file is, not the data. `file` is relative to DATA_DIR/db. */
type SnapshotPointer = { kind: string; file: string; bytes: number };

const DB_DIR = path.join(DATA_DIR, 'db');
const ephemeralFiles = new Map<string, string>();   // the replay harness never writes the operator's data

/** Each snapshot is its own file (temp + rename, so never half-written); receipts stay small. */
function writeSnapshotFile(id: string, snapshot: Snapshot): SnapshotPointer {
  const file = `snapshots/${id.replace(/[^\w.-]/g, '_')}.json`, text = JSON.stringify(snapshot);
  if (isEphemeralStorage()) ephemeralFiles.set(file, text);
  else {
    fs.mkdirSync(path.join(DB_DIR, 'snapshots'), { recursive: true, mode: 0o700 });
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

/** Stable pages from one immutable observation, with complete rows and explicit omissions. */
export function recordPage(kind: string, data: Record<string, any>, key: string, input: Record<string, unknown>) {
  const found = input.snapshotId ? findSnapshot(kind, String(input.snapshotId)) : undefined;
  if (input.snapshotId && !found) throw new Error(`Unknown snapshot for this tool: ${input.snapshotId}. Copy snapshotId exactly from the first ${kind} result, or call ${kind} without snapshotId to start a fresh snapshot.`);
  const old = found?.snapshot;
  const full = old?.data ?? data;
  if (input.symbol && full.symbol && !sameSymbol(String(input.symbol), String(full.symbol))) throw new Error('Snapshot belongs to a different symbol');
  const id = found ? found.id : saveSnapshot({ kind, data: full });
  const all = full[key] as any[];
  const offset = Number(input.offset ?? 0), limit = Number(input.limit ?? 20);
  if (!Array.isArray(all) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid rows or page limit');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > all.length) throw new Error('Offset is outside the snapshot');
  const out = { ...full, [key]: [] as any[], snapshotId: id, offset, total: all.length, nextOffset: null as number | null };
  for (let i = offset; i < all.length && i < offset + limit; i++) {
    const candidate = { ...out, [key]: [...out[key], all[i]], nextOffset: i + 1 < all.length ? i + 1 : null };
    if (JSON.stringify(candidate).length > 9000 && out[key].length) break;
    out[key].push(all[i]);
  }
  out.nextOffset = offset + out[key].length < all.length ? offset + out[key].length : null;
  return out;
}
