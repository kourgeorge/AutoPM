import { readRecord } from '../core/storage';
import { agentContext } from '../core/agentContext';
import type { ToolDefinition } from '../core/types';

export const SAVED_RESULT_TOOLS: ToolDefinition[] = [
  { name: 'get_tool_result', description: 'Read a complete saved tool receipt in character pages. Use the receiptId from an oversized result. Each page is an exact slice of the original result. Follow nextOffset only as far as the decision needs; do not re-read pages the TURN PROGRESS block shows this turn already read.', input_schema: { type: 'object', properties: {
    receiptId: { type: 'string' }, offset: { type: 'integer', minimum: 0, maximum: 100000000 }, limit: { type: 'integer', minimum: 1, maximum: 4000 },
  }, required: ['receiptId'] } },
  { name: 'get_saved_context', description: 'Retrieve sections omitted from a cycle brief. Pages preserve the original text exactly. The cycle brief lists each omitted section with its offset: fetch just the sections you need from those offsets, not the whole context from 0.', input_schema: { type: 'object', properties: {
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
  const text = cut > 0 ? readRecord<{ saved?: Record<string, string> }>('trajectories', id.slice(0, cut))?.saved?.[id] : undefined;
  if (text === undefined) throw new Error('Saved cycle context is unavailable');
  return JSON.stringify({ snapshotId: id, ...textPage(text, offset, limit) });
}

/** Keep text left out of the model's context on the running trajectory. Null outside an agent turn. */
export function saveContext(text: string): string | null {
  const store = agentContext.getStore();
  if (!store?.saved) return null;
  const id = `${store.requestId}:context-${Object.keys(store.saved).length + 1}`;
  store.saved[id] = text;
  return id;
}

/** Omit whole sections explicitly, keeping the full original available to the model. The header
 * names each omitted section and the offset that fetches just it, so the model never has to page
 * the whole saved context from offset 0 to find one section (T-21 #3). */
export function boundedCycleContext(text: string, budget = 22000): string {
  if (text.length <= budget) return text;
  const id = saveContext(text);
  if (!id) return text;   // Outside an agent turn no model reads it.
  const sections = text.split(/(?=^=== (?!END))/m);
  const title = (section: string) => (section.split('\n')[0].replace(/^=+\s*|\s*=+$/g, '') || 'untitled').slice(0, 80);
  const intro = `Full cycle context saved as ${id}.\n`;
  const rule = 'An omitted section is UNKNOWN, not empty: never treat it as an empty set. Fetch only the omitted sections a decision needs, with get_saved_context(snapshotId, offset) at the offsets listed; do not page the whole context from offset 0. Do not fetch a section again if the TURN PROGRESS block shows this turn already read it, unless you need fresher data for an order.\n';
  const starts: number[] = [];
  sections.reduce((at, section) => (starts.push(at), at + section.length), 0);
  const entry = (i: number) => `${title(sections[i])} (offset ${starts[i]}, ${sections[i].length} characters)`;
  const placeholder = (i: number) => `${sections[i].split('\n')[0].slice(0, 120)}\n[Whole section omitted: ${sections[i].length} characters. Fetch just it with get_saved_context(snapshotId "${id}", offset ${starts[i]}); follow nextOffset only until offset ${starts[i] + sections[i].length}.]\n`;
  // Start as if every section were omitted; keeping one frees its placeholder and list entry.
  const cost = sections.map((_, i) => placeholder(i).length + entry(i).length + 3);
  let remaining = budget - intro.length - rule.length - 30 - cost.reduce((a, c) => a + c, 0);
  const body: string[] = [], omitted: string[] = [];
  sections.forEach((section, i) => {
    if (section.length + 1 <= remaining + cost[i]) { body.push(section); remaining += cost[i] - section.length - 1; }
    else { omitted.push(entry(i)); body.push(placeholder(i)); }
  });
  const header = omitted.length ? `${intro}Omitted sections: ${omitted.join('; ')}.\n${rule}` : intro;
  return [header, ...body].join('\n');
}
