/**
 * The trader's memory: what it learned about a stock, about how it behaves, and about mistakes
 * it made. Account strategy remains authoritative — a lesson is advice to its future self.
 *
 * Three kinds, because they are used differently:
 *   stock      how one stock behaves (gaps on earnings, fades after a breakout) — needs a symbol
 *   behaviour  a habit of the agent's own, good or bad, worth keeping or changing
 *   mistake    an error it made (a refused order, a missed check, a bad exit) and the fix
 *
 * Evidence (journal decision IDs) is welcome but optional: a mistake such as a refused tool call
 * often has no decision behind it, and demanding one is what kept this store empty. Made-up IDs
 * are still refused.
 */
import crypto from 'crypto';
import { transaction, saveRecord, readRecord, listRecords } from '../core/storage';
import { readDecision } from './journal';
import { agentContext, assertAgentActive, recordToolResult } from '../core/agentContext';
import { canonicalSymbol } from '../core/symbols';

export const LESSON_CATEGORIES = ['stock', 'behaviour', 'mistake'] as const;
export type LessonCategory = typeof LESSON_CATEGORIES[number];

/** Older records may carry extra fields (scope, reviewAfter, policyHash, …); they are ignored. */
export interface Lesson { id: string; at: string; category?: LessonCategory; symbol?: string | null; text: string;
  evidenceIds: string[]; active: boolean; replacedBy?: string | null; actorId: string }
export interface LessonDetails { category?: string; symbol?: string | null; supersedes?: string | null }

let ephemeral = false;
export function useEphemeralLessons(): void { ephemeral = true; }

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Saves a lesson and returns its id. An identical active lesson is returned instead of copied. */
export function recordLesson(text: string, evidenceIds: string[] = [], details: LessonDetails = {}): string {
  assertAgentActive();
  const body = text.trim(), context = agentContext.getStore();
  if (!body || body.length > 2000) throw new Error('A lesson must contain 1–2000 characters');
  const category = (details.category ?? 'behaviour') as LessonCategory;
  if (!LESSON_CATEGORIES.includes(category)) throw new Error(`Lesson category must be one of ${LESSON_CATEGORIES.join(', ')}`);
  const symbol = details.symbol?.trim() ? canonicalSymbol(details.symbol) : null;
  if (category === 'stock' && !symbol) throw new Error('A stock lesson needs the symbol it is about');
  const evidence = [...new Set(evidenceIds)];
  if (evidence.length > 10 || evidence.some(id => !readDecision(id))) throw new Error('Lesson evidence must reference existing journal decision IDs (or leave evidenceIds empty)');
  const replaced = details.supersedes ? readRecord<Lesson>('lessons', details.supersedes) : null;
  if (details.supersedes && !replaced) throw new Error(`Unknown lesson to replace: ${details.supersedes}`);

  if (ephemeral) return body;
  const duplicate = listLessons(100, true).find(l => normalize(l.text) === normalize(body));
  if (duplicate) { recordToolResult({ ok: true, lessonId: duplicate.id, stored: body, duplicate: true }); return duplicate.id; }

  const id = context?.toolCallId ?? crypto.randomUUID();
  transaction(() => {
    const lesson: Lesson = { id, at: new Date().toISOString(), category, symbol, text: body, evidenceIds: evidence,
      active: true, replacedBy: null, actorId: context?.actorId ?? 'operator' };
    if (!readRecord('lessons', id)) saveRecord('lessons', id, lesson);
    if (replaced) saveRecord('lessons', replaced.id, { ...replaced, active: false, replacedBy: id });
    recordToolResult({ ok: true, lessonId: id, stored: body });
  });
  return id;
}

export function listLessons(limit = 100, activeOnly = false, filter: { symbol?: string; category?: string } = {}): Lesson[] {
  if (ephemeral) return [];
  const symbol = filter.symbol ? canonicalSymbol(filter.symbol) : undefined;
  return listRecords<Lesson>('lessons', { desc: true, limit: Math.min(100, limit), where: l =>
    (!activeOnly || l.active === true) && (!symbol || l.symbol === symbol) && (!filter.category || (l.category ?? 'behaviour') === filter.category) })
    .map(r => r.value);
}

/** One lesson as the trader reads it: the text in full, then where it came from. */
export function describeLesson(l: Lesson): string {
  const tag = l.symbol ? `[${l.symbol}] ` : '';
  const evidence = l.evidenceIds.length ? `evidence: ${l.evidenceIds.join(', ')}; ` : '';
  return `- ${tag}${l.text} (${evidence}saved ${l.at.slice(0, 10)}; lesson ${l.id})`;
}

/** Newest-last, for the operator's /lessons command. */
export function readLessons(limit = 20): string[] {
  return listLessons(limit, true).reverse().map(describeLesson);
}

/**
 * The memory block for a trader cycle. Lessons about stocks in play (held, or named by this
 * cycle's events) come first and are never dropped for space; the rest fill up to `max`.
 */
export function lessonsForContext(focusSymbols: string[], max = 30): { text: string; shown: number; total: number } {
  const all = listLessons(100, true);
  if (!all.length) return { text: '', shown: 0, total: 0 };
  const focus = new Set(focusSymbols.map(canonicalSymbol));
  const pinned = all.filter(l => l.symbol && focus.has(l.symbol));
  const rest = all.filter(l => !pinned.includes(l)).slice(0, Math.max(0, max - pinned.length));
  const chosen = new Set([...pinned, ...rest]);
  const sections: Array<[string, Lesson[]]> = [
    ['Mistakes to avoid repeating', all.filter(l => chosen.has(l) && l.category === 'mistake')],
    ['Your own behaviour', all.filter(l => chosen.has(l) && (l.category ?? 'behaviour') === 'behaviour')],
    ['How stocks behave (stocks in play first)', [...pinned, ...rest].filter(l => l.category === 'stock')],
  ];
  const lines: string[] = [];
  for (const [title, rows] of sections) {
    if (!rows.length) continue;
    lines.push('', `${title}:`);
    for (const l of rows) lines.push(describeLesson(l));
  }
  return { text: lines.join('\n'), shown: chosen.size, total: all.length };
}

export function reviewLesson(id: string, text: string, active: boolean): Lesson {
  const old = readRecord<Lesson>('lessons', id);
  if (!old) throw new Error('Unknown lesson');
  if (!text.trim() || text.length > 2000 || typeof active !== 'boolean') throw new Error('Provide valid lesson text and active status');
  const next = { ...old, text: text.trim(), active };
  saveRecord('lessons', id, next);
  return next;
}
