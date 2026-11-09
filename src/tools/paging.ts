import crypto from 'crypto';
import { appendRecord, readRecord, saveRecord } from '../core/storage';
import { agentContext } from '../core/agentContext';
import { sameSymbol } from '../core/symbols';

type Snapshot = { kind: string; data: Record<string, any> };

/** Keep the full observation on the tool call's receipt; its id is the snapshotId. */
function saveSnapshot(snapshot: Snapshot): string {
  const call = agentContext.getStore()?.toolCallId;
  if (call) { saveRecord('tool-calls', call, { ...readRecord<object>('tool-calls', call), snapshot }); return call; }
  const id = 'snapshot-' + crypto.randomUUID(), at = new Date().toISOString();
  appendRecord('tool-calls', id, at, { name: snapshot.kind, snapshot, startedAt: at, finishedAt: at });
  return id;
}

type Receipt = { name?: string; input?: { snapshotId?: unknown }; snapshot?: Snapshot };

/**
 * The receipt holding the snapshot. Only the first call stores it; a later page's receipt
 * points back to it through its own input, and models often pass that later receipt id, so follow it.
 */
function findSnapshot(kind: string, start: string): { id: string; snapshot: Snapshot } | undefined {
  let id = start;
  for (let hop = 0; hop < 20; hop++) {
    const row = readRecord<Receipt>('tool-calls', id);
    if (row?.snapshot) return row.snapshot.kind === kind ? { id, snapshot: row.snapshot } : undefined;
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
