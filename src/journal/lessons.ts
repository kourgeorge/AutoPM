/** Evidence-linked advisory observations. Account strategy remains authoritative. */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DATA_DIR } from '../core/paths';
import { readValue, saveValue, transaction, saveRecord, readRecord, readRecords, database } from '../core/storage';
import { getPolicyHash } from '../policy/load';
import { readDecision } from './journal';
import { agentContext, assertAgentActive, recordToolEffect } from '../core/agentContext';
export const LESSONS_FILE = path.join(DATA_DIR, 'LESSONS.md');
export interface Lesson { id: string; text: string; evidenceIds: string[]; policyHash: string; at: string; active: boolean; actorId: string; reviewedBy?: string }
let ephemeral = false;
export function useEphemeralLessons(): void { ephemeral = true; }
function migrate(): void {
  if (readValue('import:structuredLessons')) return;
  transaction(() => {
    const old = readRecords<string | Lesson>('lesson');
    if (!readValue('import:lessons') && fs.existsSync(LESSONS_FILE)) old.push(...fs.readFileSync(LESSONS_FILE, 'utf8').split(/^(?=## \d{4}-\d{2}-\d{2}T)/m).map(s => s.trim()).filter(s => /^## \d/.test(s)));
    const rows = database().prepare("SELECT id FROM records WHERE kind='lesson' ORDER BY seq").all();
    old.forEach((value, i) => {
      if (typeof value !== 'string') return;
      const id = rows[i]?.id ?? 'legacy-' + i;
      saveRecord('lesson', id, { id, text: value, evidenceIds: [], policyHash: '', at: '', active: false, actorId: 'legacy' });
    });
    saveValue('import:lessons', true); saveValue('import:structuredLessons', true);
  });
}
export function recordLesson(text: string, evidenceIds: string[] = []): string {
  assertAgentActive();
  const body = text.trim(), context = agentContext.getStore();
  if (!body || body.length > 2000) throw new Error('A lesson must contain 1–2000 characters');
  if (context && !evidenceIds.length) throw new Error('A lesson requires source decision IDs');
  if (evidenceIds.length > 10 || evidenceIds.some(id => !readDecision(id))) throw new Error('Lesson evidence must reference existing decisions');
  if (!ephemeral) transaction(() => {
    migrate();
    const id = context?.attemptId ?? crypto.randomUUID();
    const lesson: Lesson = { id, text: body, evidenceIds, policyHash: getPolicyHash(), at: new Date().toISOString(), active: true, actorId: context?.actorId ?? 'operator' };
    if (!readRecord('lesson', id)) saveRecord('lesson', id, lesson);
    recordToolEffect({ ok: true, lessonId: id, stored: body });
  });
  return body;
}
export function listLessons(limit = 100, activeOnly = false): Lesson[] {
  if (ephemeral) return [];
  migrate();
  return database().prepare("SELECT value FROM records WHERE kind='lesson'" + (activeOnly ? " AND json_extract(value,'$.active')=1" : '') + ' ORDER BY seq DESC LIMIT ?')
    .all(Math.min(100, limit)).map(r => JSON.parse(r.value));
}
export function readLessons(limit = 20): string[] {
  return listLessons(limit, true).reverse().map(l => `${l.text} [evidence: ${l.evidenceIds.join(', ') || 'operator observation'}; lesson ${l.id}]`);
}
export function reviewLesson(id: string, text: string, active: boolean, actorId: string): Lesson {
  migrate();
  const old = readRecord<Lesson>('lesson', id);
  if (!old) throw new Error('Unknown lesson');
  if (!text.trim() || text.length > 2000 || typeof active !== 'boolean') throw new Error('Provide valid lesson text and active status');
  const next = { ...old, text: text.trim(), active, reviewedBy: actorId };
  transaction(() => { saveRecord('lesson', id, next); saveRecord('lessonReview', crypto.randomUUID(), { ...next, reviewedAt: new Date().toISOString() }); });
  return next;
}
