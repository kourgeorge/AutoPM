import crypto from 'crypto';
import { appendRecord, listRecords, transaction } from '../core/storage';
import { agentContext, assertAgentActive, recordToolResult } from '../core/agentContext';
import { readEvidence, validateEvidenceIds } from '../journal/evidence';
import { validateThesis, evaluatePremises, type PositionReview, type EntryThesis } from '../journal/thesis';
import { collectBars } from '../collect/barSource';
import { isUsable } from '../collect/types';
import { etNow } from '../core/time';
import { getPolicyHash } from '../policy/load';
import type { Bar } from '../core/types';
import type { DecisionRecord } from '../journal/types';
import { sameSymbol } from '../core/symbols';

export interface CandidateReviewDetails { thesis?: EntryThesis; entryPlanId?: string; unknowns?: string[]; nextReviewAt?: string }
export interface CandidateReview extends CandidateReviewDetails { id: string; at: string; symbol: string; decision: 'buy' | 'wait' | 'skip'; reason: string; evidenceIds: string[];
  snapshotId: string; price: number | null; contextVariant: string; policyHash: string }

export function saveCandidateReview(symbol: string, decision: CandidateReview['decision'], reason: string, evidenceIds: string[], snapshotId: string, details: CandidateReviewDetails = {}) {
  assertAgentActive();
  if (!['buy', 'wait', 'skip'].includes(decision)) throw new Error('Candidate assessment must be buy, wait or skip');
  const evidence = validateEvidenceIds(evidenceIds, symbol), snapshot = evidence.find(e => e.id === snapshotId);
  if (!snapshot) throw new Error('snapshotId must be included in evidenceIds. Use the evidenceId returned by get_position_review for this symbol');
  if (snapshot.tool !== 'get_position_review') throw new Error(`snapshotId references ${snapshot.tool}; use the evidenceId returned by get_position_review for this symbol and include it in evidenceIds. Signals, calendar and fundamentals evidence can support the review but cannot serve as snapshotId`);
  if (snapshot.data.positionKnown !== true) throw new Error('Candidate holding status is unknown. Refresh get_position_review after broker positions are available; a null holding alone does not confirm the symbol is not held');
  if (snapshot.data.holding) throw new Error('The get_position_review snapshot confirms a current holding. Use record_position_review for a managed holding assessment');
  const fresh = (at: string) => { const age = Date.now() - Date.parse(at); return Number.isFinite(age) && age >= -30_000 && age <= 15 * 60000; };
  if (!fresh(snapshot.recordedAt)) throw new Error('Candidate snapshot is not fresh; refresh it');
  if (snapshot.data.policyHash !== getPolicyHash()) throw new Error('Strategy changed since this candidate snapshot');
  if (typeof reason !== 'string' || reason.trim().length < 20 || reason.length > 2000) throw new Error('State the material reason for the candidate assessment in 20–2000 characters');
  const thesis = details.thesis ? validateThesis(details.thesis, symbol) : undefined;
  if (details.unknowns !== undefined && (!Array.isArray(details.unknowns) || details.unknowns.length > 8 || details.unknowns.some(s => typeof s !== 'string' || !s.trim() || s.length > 300))) throw new Error('Provide up to 8 explicit unknowns');
  if (details.nextReviewAt !== undefined) {
    const nextAt = Date.parse(details.nextReviewAt);
    if (!Number.isFinite(nextAt) || nextAt <= Date.now() || nextAt > Date.now() + 30 * 86400000) throw new Error('Next review must be within the next 30 days');
  }
  const plan = details.entryPlanId ? evidence.find(e => e.id === details.entryPlanId) : undefined;
  if (details.entryPlanId && (plan?.tool !== 'get_entry_plan' || !fresh(plan.recordedAt) || plan.data.policyHash !== getPolicyHash() || !sameSymbol(plan.data.symbol ?? '', symbol))) throw new Error('Entry plan must reference a fresh get_entry_plan observation for this symbol and strategy');
  if (decision === 'buy') {
    if (!thesis) throw new Error('A buy candidate requires an evidence-linked proposed thesis');
    if (evaluatePremises(thesis, snapshot.data.metrics ?? {}).premises.some(p => p.metric !== 'qualitative' && p.status !== 'supported')) throw new Error('Numeric proposed thesis conditions must be supported by the candidate snapshot');
    const levels = plan?.data.proposedLevels;
    if (!plan || plan.data.allowed !== true || !Number.isFinite(plan.data.maxQty) || plan.data.maxQty < 1 || !Number.isFinite(plan.data.entryPrice)
      || !levels || !Number.isFinite(levels.stopLoss) || !Number.isFinite(levels.takeProfit) || !(levels.stopLoss > 0 && levels.stopLoss < plan.data.entryPrice && levels.takeProfit > plan.data.entryPrice)) throw new Error('A buy candidate requires a fresh allowed entry plan with a feasible size and supported stop/target levels. Record a conditional wait if execution inputs are unavailable');
  }
  const savedDetails = { ...(thesis ? { thesis } : {}), ...(details.entryPlanId ? { entryPlanId: details.entryPlanId } : {}),
    ...(details.unknowns !== undefined ? { unknowns: [...details.unknowns] } : {}), ...(details.nextReviewAt ? { nextReviewAt: details.nextReviewAt } : {}) };
  const old = listRecords<CandidateReview>('candidate-reviews', { where: r => sameSymbol(r.symbol, symbol), desc: true, limit: 1 })[0]?.value;
  if (old?.decision === decision && old.reason === reason && old.policyHash === getPolicyHash()
    && JSON.stringify([old.thesis, old.entryPlanId, old.unknowns, old.nextReviewAt]) === JSON.stringify([thesis, details.entryPlanId, details.unknowns, details.nextReviewAt])) return { ok: true, unchanged: true, reviewId: old.id };
  const id = 'candidate-' + (agentContext.getStore()?.toolCallId ?? crypto.randomUUID());
  const row: CandidateReview = { id, at: new Date().toISOString(), symbol, decision, reason, evidenceIds, snapshotId, ...savedDetails,
    price: snapshot.data.forward?.price ?? null, contextVariant: snapshot.data.contextVariant ?? 'decision-context-v1', policyHash: getPolicyHash() };
  const result = { ok: true, reviewId: id, note: 'Candidate research recommendation saved. This does not place or approve an order; execution rechecks the full strategy.' };
  return transaction(() => { appendRecord('candidate-reviews', id, row.at, row); recordToolResult(result); return result; });
}

/** Rebase a contemporaneous quote using the SAME daily close observed at decision time. */
export function adjustedReferencePrice(price: number | null, observedClose: { value: number | null; asOf: string | null } | undefined, bars: Bar[]): number | null {
  if (price == null || !Number.isFinite(price) || price <= 0 || !observedClose?.value || !observedClose.asOf) return null;
  const anchor = bars.find(b => b.t.slice(0, 10) === observedClose.asOf!.slice(0, 10));
  const adjusted = anchor ? price * anchor.c / observedClose.value : NaN;
  return Number.isFinite(adjusted) && adjusted > 0 ? adjusted : null;
}

export function followupPath(price: number | null, at: string, bars: Bar[], horizon: number, costBps: number | null) {
  const day = etNow(new Date(at)).date;
  const after = bars.filter(b => b.t.slice(0, 10) > day).slice(0, horizon);
  if (price == null || price <= 0 || !Number.isFinite(price) || after.length < horizon) return null;
  // If the cached range starts long after the decision, counting its first N bars is invalid.
  if (!bars.some(b => b.t.slice(0, 10) <= day)) return null;
  const grossReturnPct = (after.at(-1)!.c / price - 1) * 100;
  return { sessions: horizon, end: after.at(-1)!.t, referencePrice: price, endPrice: after.at(-1)!.c,
    grossReturnPct, estimatedReturnAfterSpreadPct: costBps == null ? null : grossReturnPct - costBps / 100,
    mfePct: (Math.max(...after.map(b => b.h)) / price - 1) * 100,
    maePct: (Math.min(...after.map(b => b.l)) / price - 1) * 100, assumedRoundTripCostBps: costBps };
}

export async function decisionFollowup(symbol?: string, days = 90, limit = 20, roundTripCostBps?: number) {
  const since = Date.now() - days * 86400000;
  const matches = (r: { at: string; symbol: string }) => (!symbol || r.symbol === symbol) && Date.parse(r.at) >= since;
  const actions = listRecords<DecisionRecord>('journal', { where: r => !!r.symbol && matches({ at: r.at, symbol: r.symbol }) && ['entry', 'exit'].includes(r.kind), desc: true, limit }).map(r => {
    const d = r.value, snapshotId = d.observationIds?.find(id => readEvidence(id)?.tool === 'get_position_review');
    if (!snapshotId) return null;
    const snapshot = readEvidence(snapshotId)!;
    return { id: d.id, symbol: d.symbol!, at: d.at, decision: d.kind, snapshotId, price: snapshot.data.forward?.price ?? null,
      contextVariant: snapshot.data.contextVariant ?? 'unknown', policyHash: d.policyHash ?? 'unknown', orderStatus: d.orderStatus ?? 'unknown', executed: d.executed };
  }).filter((r): r is NonNullable<typeof r> => r !== null);
  const reviews = [...listRecords<PositionReview>('position-reviews', { where: matches, desc: true, limit }).map(r => r.value),
    ...listRecords<CandidateReview>('candidate-reviews', { where: matches, desc: true, limit }).map(r => r.value), ...actions]
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  const histories = new Map(await Promise.all([...new Set([...reviews.map(r => r.symbol), 'SPY'])].map(async (s): Promise<[string, { bars: Bar[]; error: string | null }]> => {
    try { const bars = await collectBars(s, 420, '1Day', undefined, 'split'); return [s, isUsable(bars) ? { bars: bars.value, error: null } : { bars: [], error: 'Fresh history unavailable' }]; }
    catch (err: any) { return [s, { bars: [], error: err.message }]; }
  })));
  const rows = reviews.map(r => {
    const snapshot = readEvidence(r.snapshotId), estimatedCost = roundTripCostBps ?? snapshot?.data.liquidity?.spreadBps ?? null;
    const stock = histories.get(r.symbol)?.bars ?? [], referencePrice = adjustedReferencePrice(r.price, snapshot?.data.metrics?.lastClose, stock);
    return { reviewId: r.id, symbol: r.symbol, at: r.at, decision: r.decision, contextVariant: r.contextVariant, policyHash: r.policyHash,
      orderStatus: 'orderStatus' in r ? r.orderStatus : null, executed: 'executed' in r ? r.executed : false,
      referenceAvailable: referencePrice !== null, recordedReferencePrice: r.price, historyError: histories.get(r.symbol)?.error ?? null,
      horizons: [1, 5, 20].map(horizon => ({ horizon,
        passiveStock: followupPath(referencePrice, r.at, stock, horizon, estimatedCost),
        passiveBenchmark: (() => { const market = histories.get('SPY')?.bars ?? [], day = etNow(new Date(r.at)).date;
          const start = market.filter(b => b.t.slice(0, 10) <= day).at(-1);
          return followupPath(start?.c ?? null, r.at, market, horizon, roundTripCostBps ?? null); })() })) };
  });
  const groups = [...new Set(rows.map(r => r.contextVariant))].map(variant => {
    const group = rows.filter(r => r.contextVariant === variant), paths = group.map(r => r.horizons.find(h => h.horizon === 20)?.passiveStock).filter((p): p is NonNullable<typeof p> => p != null);
    return { contextVariant: variant, decisions: group.length, measured20SessionPaths: paths.length,
      meanPassiveReturn20dPct: paths.length ? paths.reduce((sum, p) => sum + p.grossReturnPct, 0) / paths.length : null };
  });
  return { source: 'derived', rows, groups, caveats: ['These are passive hypothetical paths, not simulated fills or realized strategy returns. Stops, targets, later decisions, cash interest and taxes are excluded.',
    'Horizon begins with sessions after the decision day. Intraday decision-day excursions are not measured.',
    'Stock reference prices are rebased through the recorded completed daily close to current split-adjusted units. Missing anchors produce unknown paths. Dividends are excluded.',
    'Benchmark begins at a completed daily close, not the stock observation time; relative results are approximate.',
    'Spread assumptions exclude unknown fees, slippage and impact. Null costs do not mean free execution.',
    'Context groups are descriptive and confounded by timing, selection and policy; they do not establish a causal improvement.'] };
}
