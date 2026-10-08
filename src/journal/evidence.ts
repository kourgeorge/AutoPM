import crypto from 'crypto';
import { appendRecord, readRecord } from '../core/storage';
import { agentContext, assertAgentActive } from '../core/agentContext';
import { sameSymbol } from '../core/symbols';

export interface Evidence {
  id: string; tool: string; symbol: string | null; recordedAt: string;
  asOf: string | null; source: string; data: Record<string, any>;
}
export function recordEvidence(tool: string, data: Record<string, any>, symbol?: string): Evidence {
  assertAgentActive();
  const call = agentContext.getStore()?.toolCallId;
  const id = 'evidence-' + (call ? crypto.createHash('sha256').update(call + ':' + tool + ':' + (symbol ?? data.symbol ?? '')).digest('hex').slice(0, 32) : crypto.randomUUID());
  const old = readRecord<Evidence>('evidence', id);
  if (old) return old;
  const row: Evidence = { id, tool, symbol: symbol ?? data.symbol ?? null, recordedAt: new Date().toISOString(),
    asOf: data.asOf ?? data.tickAt ?? null, source: data.source ?? 'derived', data: structuredClone(data) };
  appendRecord('evidence', id, row.recordedAt, row);
  return row;
}
export const readEvidence = (id: string) => readRecord<Evidence>('evidence', id);

/** Every quoted observation has an immutable identifier. Failed reads remain failed reads. */
export function evidenceResult(tool: string, result: string, symbol?: string): string {
  let value: any;
  try { value = JSON.parse(result); } catch { return result; }
  if (!value || typeof value !== 'object' || value.error || value.ok === false) return result;
  const data = Array.isArray(value) ? { items: value } : value;
  return JSON.stringify({ ...data, evidenceId: recordEvidence(tool, data, symbol).id });
}

export function validateEvidenceIds(ids: string[], symbol?: string): Evidence[] {
  if (!Array.isArray(ids) || !ids.length || ids.length > 10) throw new Error('Supply 1–10 existing observation evidence IDs');
  return [...new Set(ids)].map(id => {
    const row = readEvidence(id);
    if (!row) throw new Error('Unknown observation evidence ID: ' + id);
    if (symbol && row.symbol && !sameSymbol(row.symbol, symbol)) throw new Error('Evidence belongs to a different symbol: ' + id);
    return row;
  });
}
