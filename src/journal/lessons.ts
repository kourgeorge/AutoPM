/** Evidence-linked advisory observations. Account strategy remains authoritative. */
import crypto from 'crypto';
import { transaction, saveRecord, readRecord, listRecords } from '../core/storage';
import { getPolicyHash } from '../policy/load';
import { readDecision } from './journal';
import { agentContext, assertAgentActive, recordToolResult } from '../core/agentContext';
export interface Lesson { id: string; text: string; evidenceIds: string[]; policyHash: string; at: string; active: boolean; actorId: string;
  counterEvidenceIds?: string[]; reviewAfter?: string; scope?: string; sampleCount?: number | null; completedExitCount?: number | null }
export interface LessonDetails { counterEvidenceIds?: string[]; reviewAfter?: string; scope?: string }
let ephemeral = false;
export function useEphemeralLessons(): void { ephemeral = true; }
export function recordLesson(text: string, evidenceIds: string[] = [], details: LessonDetails = {}): string {
  assertAgentActive();
  const body = text.trim(), context = agentContext.getStore();
  if (!body || body.length > 2000) throw new Error('A lesson must contain 1–2000 characters');
  if (context && !evidenceIds.length) throw new Error('A lesson requires source decision IDs');
  if (evidenceIds.length > 10 || evidenceIds.some(id => !readDecision(id))) throw new Error('Lesson evidence must reference existing decisions');
  const supporting = [...new Set(evidenceIds)], counter = [...new Set(details.counterEvidenceIds ?? [])];
  if (counter.length > 10 || counter.some(id => !readDecision(id) || supporting.includes(id))) throw new Error('Counter-evidence must reference distinct existing decisions');
  const reviewAfter = details.reviewAfter ?? new Date(Date.now() + 30 * 86400000).toISOString();
  if (!Number.isFinite(Date.parse(reviewAfter)) || Date.parse(reviewAfter) <= Date.now() || Date.parse(reviewAfter) > Date.now() + 365 * 86400000) throw new Error('Lesson review date must be within the next year');
  if (!ephemeral) transaction(() => {
    const id = context?.toolCallId ?? crypto.randomUUID();
    const lesson: Lesson = { id, text: body, evidenceIds: supporting, counterEvidenceIds: counter, reviewAfter, scope: details.scope ?? 'Unspecified; advisory observation',
      sampleCount: supporting.length, completedExitCount: supporting.filter(id => { const d = readDecision(id)!; return d.kind === 'exit' && d.executed; }).length,
      policyHash: getPolicyHash(), at: new Date().toISOString(), active: true, actorId: context?.actorId ?? 'operator' };
    if (!readRecord('lessons', id)) saveRecord('lessons', id, lesson);
    recordToolResult({ ok: true, lessonId: id, stored: body });
  });
  return body;
}
export function listLessons(limit = 100, activeOnly = false): Lesson[] {
  if (ephemeral) return [];
  return listRecords<Lesson>('lessons', { where: activeOnly ? l => l.active === true : undefined, desc: true, limit: Math.min(100, limit) })
    .map(r => r.value);
}
export function readLessons(limit = 20): string[] {
  return listLessons(limit, true).reverse().map(l => `${l.text} [evidence: ${l.evidenceIds.join(', ') || 'operator observation'}; decision samples: ${l.sampleCount ?? 'unknown'} (not independent trades); confirmed exit records: ${l.completedExitCount ?? 'unknown'}; counter-evidence: ${l.counterEvidenceIds?.join(', ') || 'none recorded — not proof none exists'}; scope: ${l.scope ?? 'unknown'}; review: ${l.reviewAfter ?? 'unscheduled'}${l.reviewAfter && Date.parse(l.reviewAfter) <= Date.now() ? ' DUE' : ''}${l.policyHash !== getPolicyHash() ? '; strategy changed since observation' : ''}; lesson ${l.id}]`);
}
export function reviewLesson(id: string, text: string, active: boolean): Lesson {
  const old = readRecord<Lesson>('lessons', id);
  if (!old) throw new Error('Unknown lesson');
  if (!text.trim() || text.length > 2000 || typeof active !== 'boolean') throw new Error('Provide valid lesson text and active status');
  const next = { ...old, text: text.trim(), active };
  saveRecord('lessons', id, next);
  return next;
}
