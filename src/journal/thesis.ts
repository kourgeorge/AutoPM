import crypto from 'crypto';
import { readDecision, decision, recordDecision } from './journal';
import { validateEvidenceIds } from './evidence';
import { readRecord, appendRecord, listRecords, transaction } from '../core/storage';
import { agentContext, assertAgentActive, recordToolResult } from '../core/agentContext';
import { canonicalSymbol } from '../core/symbols';
import { getPositionSnapshot } from '../state/state';

export const THESIS_METRICS = ['lastClose', 'rsi', 'emaSpreadPct', 'trendComposite', 'relativeMarket20dPct',
  'relativeSector20dPct', 'earningsDaysUntil', 'epsRevisionsUp30d', 'epsRevisionsDown30d',
  'freeCashflow', 'revenueGrowthPct', 'qualitative'] as const;
export type ThesisMetric = typeof THESIS_METRICS[number];
export interface Premise {
  label: string; metric: ThesisMetric; operator?: 'gt' | 'gte' | 'lt' | 'lte'; threshold?: number; evidenceIds: string[];
}
export interface EntryThesis {
  setup: string; horizonDays: number; premises: Premise[]; catalystRiskAccepted: boolean;
  sharedDrivers?: Array<{ driver: string; evidenceIds: string[] }>;
}
export interface Fact { value: number | null; asOf: string | null; source: string; evidenceId?: string }
export type Facts = Partial<Record<ThesisMetric, Fact>>;
/** Position and candidate reviews share the `reviews` file, told apart by `type`. */
export interface PositionReview {
  type: 'position'; id: string; symbol: string; entryDecisionId: string | null; at: string; decision: 'keep' | 'reduce' | 'exit' | 'wait';
  changedEvidence: string; evidenceIds: string[]; unknowns: string[]; nextReviewAt: string; price: number | null;
  contextVariant: string; snapshotId: string; policyHash: string; holdingHorizonDays: number | null;
}

export function validateThesis(value: EntryThesis, symbol: string): EntryThesis {
  if (!value || typeof value.setup !== 'string' || value.setup.trim().length < 10 || value.setup.length > 1000 ||
      !Number.isInteger(value.horizonDays) || value.horizonDays < 1 || value.horizonDays > 365 ||
      typeof value.catalystRiskAccepted !== 'boolean' || !Array.isArray(value.premises) || !value.premises.length || value.premises.length > 8) throw new Error('Provide a setup, 1–365 day horizon, catalyst risk choice and 1–8 evidence-linked premises');
  for (const p of value.premises) {
    if (!p.label?.trim() || !THESIS_METRICS.includes(p.metric)) throw new Error('Unknown thesis premise or metric');
    const evidence = validateEvidenceIds(p.evidenceIds, symbol);
    if (p.metric !== 'qualitative' && !evidence.some(e => Number.isFinite(e.data.metrics?.[p.metric]?.value) && Date.now() - Date.parse(e.recordedAt) <= 15 * 60000)) throw new Error(`Numeric premise requires a fresh measured metric in its observation snapshot: ${p.metric}. Cite evidence containing metrics.${p.metric}.value, such as the evidenceId returned by get_position_review`);
    if (p.metric !== 'qualitative' && (!['gt', 'gte', 'lt', 'lte'].includes(p.operator ?? '') || !Number.isFinite(p.threshold))) throw new Error('A numeric premise requires an operator and finite threshold');
    if (p.metric === 'qualitative' && (p.operator !== undefined || p.threshold !== undefined)) throw new Error('Qualitative premises cannot declare numeric checks');
  }
  for (const d of value.sharedDrivers ?? []) { if (!d.driver.trim()) throw new Error('Shared driver requires a description'); validateEvidenceIds(d.evidenceIds, symbol); }
  return structuredClone(value);
}

export function thesisForPosition(symbol: string): { thesis: EntryThesis | null; entryDecisionId: string | null; rationale: string | null } {
  const id = getPositionSnapshot(symbol)?.entryDecisionId;
  const entry = id ? readDecision(id) : undefined;
  return { thesis: entry?.thesis ?? null, entryDecisionId: id ?? null, rationale: entry?.rationale ?? null };
}

export function evaluatePremises(thesis: EntryThesis | null, facts: Facts) {
  if (!thesis) return { status: 'unknown' as const, premises: [], caveats: ['No structured entry thesis was recorded. Legacy prose has not been converted into invented conditions.'] };
  const premises = thesis.premises.map(p => {
    const f = facts[p.metric];
    if (p.metric === 'qualitative' || !f || f.value == null || !Number.isFinite(f.value)) return { ...p, status: 'unknown', reading: f ?? null };
    const supported = p.operator === 'gt' ? f.value > p.threshold! : p.operator === 'gte' ? f.value >= p.threshold! :
      p.operator === 'lt' ? f.value < p.threshold! : f.value <= p.threshold!;
    return { ...p, status: supported ? 'supported' : 'contradicted', reading: f };
  });
  return { status: premises.some(p => p.status === 'contradicted') ? 'contradicted' : premises.some(p => p.status === 'unknown') ? 'unknown' : 'supported',
    premises, caveats: ['Checks assess recorded premises only. They do not decide an order or establish a probability of profit.',
      'Qualitative premises require a fresh source review and remain unverified by these numeric checks.'] };
}

export function latestPositionReview(symbol: string): PositionReview | null {
  const snapshot = getPositionSnapshot(symbol);
  if (!snapshot) return null;
  const entryId = snapshot.entryDecisionId ?? null, openedAt = snapshot.openedAt ? Date.parse(snapshot.openedAt) : NaN;
  return listRecords<PositionReview>('reviews', { where: r => r.type === 'position' && canonicalSymbol(r.symbol) === canonicalSymbol(symbol)
    && r.entryDecisionId === entryId && (!Number.isFinite(openedAt) || Date.parse(r.at) >= openedAt), desc: true, limit: 1 })[0]?.value ?? null;
}

export function savePositionReview(input: Omit<PositionReview, 'type' | 'id' | 'at' | 'entryDecisionId'>) {
  assertAgentActive();
  const evidence = validateEvidenceIds(input.evidenceIds, input.symbol);
  if (input.changedEvidence.trim().length < 20) throw new Error('State the material evidence change in at least 20 characters');
  const nextAt = Date.parse(input.nextReviewAt);
  if (!Number.isFinite(nextAt) || nextAt <= Date.now() || nextAt > Date.now() + 30 * 86400000) throw new Error('Next review must be within the next 30 days');
  if (!evidence.some(e => e.id === input.snapshotId && e.tool === 'get_position_review')) throw new Error('Use the get_position_review evidence ID as snapshotId');
  const snapshot = evidence.find(e => e.id === input.snapshotId)!;
  if (Date.now() - Date.parse(snapshot.recordedAt) > 15 * 60000) throw new Error('Position review snapshot is older than 15 minutes; refresh it');
  const old = latestPositionReview(input.symbol);
  const entryDecisionId = getPositionSnapshot(input.symbol)?.entryDecisionId ?? null;
  if (!getPositionSnapshot(input.symbol)) throw new Error('No managed position snapshot exists');
  if (snapshot.data.entryDecisionId !== entryDecisionId || snapshot.data.managed !== true || !snapshot.data.holding) throw new Error('Snapshot belongs to a different or unmanaged position lifecycle');
  if (old && old.decision === input.decision && old.changedEvidence === input.changedEvidence && old.nextReviewAt === input.nextReviewAt && JSON.stringify(old.unknowns) === JSON.stringify(input.unknowns)) return { ok: true, unchanged: true, reviewId: old.id };
  return transaction(() => {
    const id = 'review-' + (agentContext.getStore()?.toolCallId ?? crypto.randomUUID());
    const previous = readRecord<PositionReview>('reviews', id);
    if (previous) return { ok: true, reviewId: id };
    const row: PositionReview = { type: 'position', ...input, entryDecisionId, id, at: new Date().toISOString() };
    appendRecord('reviews', id, row.at, row);
    recordDecision(decision('hold', 'trader', { symbol: row.symbol, rationale: `Review ${row.decision}: ${row.changedEvidence}. Unknown: ${row.unknowns.join('; ') || 'none stated'}. Review by ${row.nextReviewAt}.`,
      observationIds: row.evidenceIds, reviewId: id, price: row.price }), id);
    const result = { ok: true, reviewId: id, note: 'Review saved. This receipt does not place an order; send any chosen reduction or exit separately.' };
    recordToolResult(result); return result;
  });
}
