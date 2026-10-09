import { readRecord } from '../core/storage';
import { agentContext } from '../core/agentContext';
import type { ToolDefinition } from '../core/types';

export const SAVED_RESULT_TOOLS: ToolDefinition[] = [
  { name: 'get_tool_result', description: 'Read a complete saved tool receipt in character pages. Use the receiptId from an oversized result. Follow nextOffset until null; each page is an exact slice of the original result.', input_schema: { type: 'object', properties: {
    receiptId: { type: 'string' }, offset: { type: 'integer', minimum: 0, maximum: 100000000 }, limit: { type: 'integer', minimum: 1, maximum: 4000 },
  }, required: ['receiptId'] } },
  { name: 'get_saved_context', description: 'Retrieve sections omitted from a cycle brief. Pages preserve the original text exactly; follow nextOffset until null.', input_schema: { type: 'object', properties: {
    snapshotId: { type: 'string' }, offset: { type: 'integer', minimum: 0, maximum: 100000000 }, limit: { type: 'integer', minimum: 1, maximum: 4000 },
  }, required: ['snapshotId'] } },
];

export function textPage(text: string, offset = 0, limit = 3000) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4000) throw new Error('Page limit must be 1–4000 characters');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new Error('Offset is outside the saved text');
  let end = Math.min(text.length, offset + limit);
  // JSON escaping can make a short character page large. Always retain complete characters.
  while (end > offset && JSON.stringify(text.slice(offset, end)).length > 7500) end--;
  return { offset, text: text.slice(offset, end), totalCharacters: text.length, nextOffset: end < text.length ? end : null };
}

export function readSavedResult(name: string, input: Record<string, unknown>): string {
  const offset = Number(input.offset ?? 0), limit = Number(input.limit ?? 3000);
  if (name === 'get_tool_result') {
    const row = readRecord<{ result?: string }>('tool-calls', String(input.receiptId));
    if (row?.result === undefined) throw new Error('Saved tool receipt is unavailable');
    return JSON.stringify({ receiptId: input.receiptId, ...textPage(row.result, offset, limit) });
  }
  const id = String(input.snapshotId), cut = id.lastIndexOf(':context-');
  const text = cut > 0 ? readRecord<{ saved?: Record<string, string> }>('transcripts', id.slice(0, cut))?.saved?.[id] : undefined;
  if (text === undefined) throw new Error('Saved cycle context is unavailable');
  return JSON.stringify({ snapshotId: id, ...textPage(text, offset, limit) });
}

/** Keep text left out of the model's context on the running transcript. Null outside an agent turn. */
export function saveContext(text: string): string | null {
  const store = agentContext.getStore();
  if (!store?.saved) return null;
  const id = `${store.requestId}:context-${Object.keys(store.saved).length + 1}`;
  store.saved[id] = text;
  return id;
}

/** Omit whole sections explicitly, keeping the full original available to the model. */
export function boundedCycleContext(text: string, budget = 22000): string {
  if (text.length <= budget) return text;
  const id = saveContext(text);
  if (!id) return text;   // Outside an agent turn no model reads it.
  const sections = text.split(/(?=^=== (?!END))/m);
  const lines = [`Full cycle context saved as ${id}. Use get_saved_context(snapshotId) for omitted sections.\nAn omitted section is UNKNOWN, not empty. Read omitted portfolio/protection evidence before trading.\n`];
  let remaining = budget - lines[0].length - sections.length * 180;
  for (const section of sections) {
    if (section.length <= remaining) { lines.push(section); remaining -= section.length; }
    else lines.push(`${section.split('\n')[0]}\n[Whole section omitted: ${section.length} characters. Retrieve ${id} with get_saved_context.]\n`);
  }
  return lines.join('\n');
}
