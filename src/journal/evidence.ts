import crypto from 'crypto';
import { readRecord, saveRecord, listRecords } from '../core/storage';
import { agentContext, assertAgentActive } from '../core/agentContext';
import { canonicalSymbol, sameSymbol } from '../core/symbols';

/**
 * An observation is a saved tool result: its evidence ID is the tool call's receipt ID, so the
 * data lives once, in `tool-calls`. An observation made outside a tool call (the cycle brief)
 * is saved as a receipt of its own.
 */
export interface Evidence {
  id: string; tool: string; symbol: string | null; recordedAt: string;
  asOf: string | null; source: string; data: Record<string, any>;
}
interface Receipt { name: string; input?: any; result?: string; startedAt?: string; finishedAt?: string }

function build(id: string, tool: string, data: Record<string, any>, symbol: string | null | undefined, recordedAt: string): Evidence {
  return { id, tool, symbol: symbol || data.symbol || null, recordedAt, asOf: data.asOf ?? data.tickAt ?? null, source: data.source ?? 'derived', data };
}
/** A receipt is evidence only when its saved result carries its own id as evidenceId. */
function fromReceipt(id: string, row: Receipt | undefined): Evidence | undefined {
  if (row?.result === undefined) return undefined;
  let value: any;
  try { value = JSON.parse(row.result); } catch { return undefined; }
  if (!value || value.evidenceId !== id) return undefined;
  const { evidenceId, ...data } = value;
  const symbol = typeof row.input?.symbol === 'string' ? canonicalSymbol(row.input.symbol) : null;
  return build(id, row.name, data, symbol, row.finishedAt ?? row.startedAt ?? '');
}

export function recordEvidence(tool: string, data: Record<string, any>, symbol?: string): Evidence {
  assertAgentActive();
  const at = new Date().toISOString(), id = agentContext.getStore()?.toolCallId ?? 'evidence-' + crypto.randomUUID();
  // The receipt's result is exactly what the tool returns, so the agent loop rewrites it unchanged.
  const old = readRecord<Receipt>('tool-calls', id);
  saveRecord('tool-calls', id, { name: tool, input: symbol ? { symbol } : {}, startedAt: at, ...old,
    result: JSON.stringify({ ...data, evidenceId: id }), finishedAt: at });
  return build(id, tool, structuredClone(data), symbol, at);
}
export const readEvidence = (id: string) => fromReceipt(id, readRecord<Receipt>('tool-calls', id));

/** Newest observation from `tool` that matches. */
export function latestEvidence(tool: string, where: (e: Evidence) => boolean = () => true): Evidence | null {
  for (const { id, value } of listRecords<Receipt>('tool-calls', { where: r => r.name === tool, desc: true })) {
    const e = fromReceipt(id, value);
    if (e && where(e)) return e;
  }
  return null;
}

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
