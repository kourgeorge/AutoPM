import { readRecord } from '../core/storage';
import { agentContext } from '../core/agentContext';
import { REQUEST_CHAR_LIMIT } from '../core/modelBudget';
import type { ToolDefinition } from '../core/types';

/**
 * Largest tool result kept inline in the conversation, in characters; a bigger one is replaced by
 * a receipt note and read with get_tool_result. It was 10,000, and a normal position review
 * (10.0–10.7k) went just over it on every read and cost three extra get_tool_result rounds
 * (docs/research/trader-token-use.md #5). 16,000 fits a normal dossier and is 8% of the request cap.
 */
export const INLINE_RESULT_LIMIT = 16_000;
/** Largest page of a saved receipt or saved context. A page is itself a tool result, so it must
 * stay inline: its JSON (with escaping and the small wrapper) is kept under INLINE_RESULT_LIMIT. */
export const SAVED_PAGE_MAX = 15_000;
// The JSON text of a page: a full page of plain text (plus its two quotes); escaped text gets fewer characters.
const PAGE_JSON_MAX = SAVED_PAGE_MAX + 2;
/**
 * Room for the cycle context, in characters. It was 22,000 while the conversation has about
 * 100,000 of room after the instructions and tools, and in every studied turn the LESSONS block
 * (~7.9k) was the part left out (T-21 #4). A fifth of the request cap fits a normal 25–31k context.
 */
export const CYCLE_CONTEXT_BUDGET = Math.floor(REQUEST_CHAR_LIMIT / 5);

// The schema maximum is far above SAVED_PAGE_MAX so a too-big limit is clamped, not refused (T-21 #7).
const pageLimit = { type: 'integer', minimum: 1, maximum: 100000000, description: `Characters per page; up to ${SAVED_PAGE_MAX} (a larger limit is clamped). Default ${SAVED_PAGE_MAX}.` };
export const SAVED_RESULT_TOOLS: ToolDefinition[] = [
  { name: 'get_tool_result', description: 'Read a complete saved tool receipt in character pages. Use the receiptId from an oversized result. Each page is an exact slice of the original result. Follow nextOffset only as far as the decision needs; do not re-read pages the TURN PROGRESS block shows this turn already read.', input_schema: { type: 'object', properties: {
    receiptId: { type: 'string' }, offset: { type: 'integer', minimum: 0, maximum: 100000000 }, limit: pageLimit,
  }, required: ['receiptId'] } },
  { name: 'get_saved_context', description: 'Retrieve sections omitted from a cycle brief. Pages preserve the original text exactly. Pass section (a section name from the "Omitted sections" list, e.g. "LESSONS") to fetch just that section, or the offset listed for it; do not page the whole context from 0.', input_schema: { type: 'object', properties: {
    snapshotId: { type: 'string' }, section: { type: 'string', maxLength: 200 }, offset: { type: 'integer', minimum: 0, maximum: 100000000 }, limit: pageLimit,
  }, required: ['snapshotId'] } },
];

/** An exact page of `text`. A limit above SAVED_PAGE_MAX is clamped to it. */
export function textPage(text: string, offset = 0, limit = SAVED_PAGE_MAX) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`Page limit must be 1–${SAVED_PAGE_MAX} characters`);
  limit = Math.min(limit, SAVED_PAGE_MAX);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new Error('Offset is outside the saved text');
  let end = Math.min(text.length, offset + limit);
  // JSON escaping can make a short character page large. Always retain complete characters.
  while (end > offset && JSON.stringify(text.slice(offset, end)).length > PAGE_JSON_MAX) end--;
  return { offset, text: text.slice(offset, end), totalCharacters: text.length, nextOffset: end < text.length ? end : null };
}

/** A cycle context's sections, split the same way `boundedCycleContext` splits them. */
const splitSections = (text: string) => text.split(/(?=^=== (?!END))/m);
const sectionTitle = (section: string) => (section.split('\n')[0].replace(/^=+\s*|\s*=+$/g, '') || 'untitled').slice(0, 80);
const isLessons = (section: string) => /^LESSONS\b/i.test(sectionTitle(section));

/** Where the named section starts and ends; the name may be any part of its title, any case. */
function findSection(text: string, name: string): { title: string; start: number; end: number } {
  const sections = splitSections(text), want = name.replace(/^=+\s*|\s*=+$/g, '').trim().toUpperCase();
  let at = 0;
  const all = sections.map(section => { const s = { title: sectionTitle(section), start: at, end: at + section.length }; at = s.end; return s; });
  const hit = all.find(s => s.title.toUpperCase() === want) ?? all.find(s => s.title.toUpperCase().startsWith(want)) ?? all.find(s => s.title.toUpperCase().includes(want));
  if (!hit) throw new Error(`No section "${name}" in this saved context. Sections: ${all.map(s => s.title).join('; ')}`);
  return hit;
}

export function readSavedResult(name: string, input: Record<string, unknown>): string {
  const offset = Number(input.offset ?? 0), limit = Number(input.limit ?? SAVED_PAGE_MAX);
  if (name === 'get_tool_result') {
    const row = readRecord<{ result?: string }>('tool-calls', String(input.receiptId));
    if (row?.result === undefined) throw new Error('Saved tool receipt is unavailable');
    return JSON.stringify({ receiptId: input.receiptId, ...textPage(row.result, offset, limit) });
  }
  const id = String(input.snapshotId), cut = id.lastIndexOf(':context-');
  const text = cut > 0 ? readRecord<{ saved?: Record<string, string> }>('trajectories', id.slice(0, cut))?.saved?.[id] : undefined;
  if (text === undefined) throw new Error('Saved cycle context is unavailable');
  if (typeof input.section === 'string' && input.section.trim()) {
    const s = findSection(text, input.section);
    const from = input.offset === undefined ? s.start : offset;
    const size = input.limit === undefined ? Math.max(1, s.end - from) : limit;
    return JSON.stringify({ snapshotId: id, section: s.title, sectionEnd: s.end, ...textPage(text, from, size) });
  }
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
export function boundedCycleContext(text: string, budget = CYCLE_CONTEXT_BUDGET): string {
  if (text.length <= budget) return text;
  const id = saveContext(text);
  if (!id) return text;   // Outside an agent turn no model reads it.
  const sections = splitSections(text), title = sectionTitle;
  const intro = `Full cycle context saved as ${id}.\n`;
  const rule = 'An omitted section is UNKNOWN, not empty: never treat it as an empty set. Fetch only the omitted sections a decision needs, with get_saved_context(snapshotId, section) by name or at the offsets listed; do not page the whole context from offset 0. Do not fetch a section again if the TURN PROGRESS block shows this turn already read it, unless you need fresher data for an order.\n';
  const starts: number[] = [];
  sections.reduce((at, section) => (starts.push(at), at + section.length), 0);
  const entry = (i: number) => `${title(sections[i])} (offset ${starts[i]}, ${sections[i].length} characters)`;
  const placeholder = (i: number) => `${sections[i].split('\n')[0].slice(0, 120)}\n[Whole section omitted: ${sections[i].length} characters. Fetch just it with get_saved_context(snapshotId "${id}", offset ${starts[i]}); follow nextOffset only until offset ${starts[i] + sections[i].length}.]\n`;
  // Start as if every section were omitted; keeping one frees its placeholder and list entry.
  const cost = sections.map((_, i) => placeholder(i).length + entry(i).length + 3);
  let remaining = budget - intro.length - rule.length - 30 - cost.reduce((a, c) => a + c, 0);
  // LESSONS is decided first ("read it before deciding", TRADER.md), then the rest in order.
  const order = sections.map((_, i) => i).sort((a, b) => Number(isLessons(sections[b])) - Number(isLessons(sections[a])) || a - b);
  const keep = new Set<number>();
  for (const i of order) if (sections[i].length + 1 <= remaining + cost[i]) { keep.add(i); remaining += cost[i] - sections[i].length - 1; }
  const body = sections.map((section, i) => keep.has(i) ? section : placeholder(i));
  const omitted = sections.flatMap((_, i) => keep.has(i) ? [] : [entry(i)]);
  const header = omitted.length ? `${intro}Omitted sections: ${omitted.join('; ')}.\n${rule}` : intro;
  return [header, ...body].join('\n');
}
