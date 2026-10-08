import crypto from 'crypto';
import { appendRecord, readRecord } from '../core/storage';
import { sameSymbol } from '../core/symbols';

/** Stable pages from one immutable observation, with complete rows and explicit omissions. */
export function recordPage(kind: string, data: Record<string, any>, key: string, input: Record<string, unknown>) {
  const id = typeof input.snapshotId === 'string' ? input.snapshotId : kind + '-' + crypto.randomUUID();
  const old = readRecord<{ kind: string; data: Record<string, any> }>('pages', id);
  if (input.snapshotId && (!old || old.kind !== kind)) throw new Error('Unknown snapshot for this tool');
  const full = old?.data ?? data;
  if (input.symbol && full.symbol && !sameSymbol(String(input.symbol), String(full.symbol))) throw new Error('Snapshot belongs to a different symbol');
  if (!old) appendRecord('pages', id, new Date().toISOString(), { kind, data: full });
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
