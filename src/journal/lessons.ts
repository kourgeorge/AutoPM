/** Evidence-linked advisory observations. Account strategy remains authoritative. */
import crypto from 'crypto';
import { transaction, saveRecord, readRecord, listRecords } from '../core/storage';
import { getPolicyHash } from '../policy/load';
import { readDecision } from './journal';
import { agentContext, assertAgentActive, recordToolResult } from '../core/agentContext';
export interface Lesson { id: string; text: string; evidenceIds: string[]; policyHash: string; at: string; active: boolean; actorId: string }
let ephemeral = false;
export function useEphemeralLessons(): void { ephemeral = true; }
export function recordLesson(text: string, evidenceIds: string[] = []): string {
  assertAgentActive();
  const body = text.trim(), context = agentContext.getStore();
  if (!body || body.length > 2000) throw new Error('A lesson must contain 1–2000 characters');
  if (context && !evidenceIds.length) throw new Error('A lesson requires source decision IDs');
  if (evidenceIds.length > 10 || evidenceIds.some(id => !readDecision(id))) throw new Error('Lesson evidence must reference existing decisions');
  if (!ephemeral) transaction(() => {
    const id = context?.toolCallId ?? crypto.randomUUID();
    const lesson: Lesson = { id, text: body, evidenceIds, policyHash: getPolicyHash(), at: new Date().toISOString(), active: true, actorId: context?.actorId ?? 'operator' };
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
  return listLessons(limit, true).reverse().map(l => `${l.text} [evidence: ${l.evidenceIds.join(', ') || 'operator observation'}; lesson ${l.id}]`);
}
export function reviewLesson(id: string, text: string, active: boolean): Lesson {
  const old = readRecord<Lesson>('lessons', id);
  if (!old) throw new Error('Unknown lesson');
  if (!text.trim() || text.length > 2000 || typeof active !== 'boolean') throw new Error('Provide valid lesson text and active status');
  const next = { ...old, text: text.trim(), active };
  saveRecord('lessons', id, next);
  return next;
}
