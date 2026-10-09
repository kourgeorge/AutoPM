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

/** Stable pages from one immutable observation, with complete rows and explicit omissions. */
export function recordPage(kind: string, data: Record<string, any>, key: string, input: Record<string, unknown>) {
  const old = typeof input.snapshotId === 'string' ? readRecord<{ snapshot?: Snapshot }>('tool-calls', input.snapshotId)?.snapshot : undefined;
  if (input.snapshotId && (!old || old.kind !== kind)) throw new Error('Unknown snapshot for this tool');
  const full = old?.data ?? data;
  if (input.symbol && full.symbol && !sameSymbol(String(input.symbol), String(full.symbol))) throw new Error('Snapshot belongs to a different symbol');
  const id = old ? String(input.snapshotId) : saveSnapshot({ kind, data: full });
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
