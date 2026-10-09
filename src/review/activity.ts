import { getAllActions } from '../core/actions';
import { readActionHistory } from '../core/actionHistory';
import { readDecisions } from '../journal/journal';
import { readFills } from './fills';
import { readAlertLog } from '../features/alertLog';
import type { TriggerEvent } from '../features/eventBus';
import { readValue, readRecord, listRecords } from '../core/storage';
import { getLastTick } from '../features/lastTick';
import { getPositionSnapshot } from '../state/state';
import { canonicalSymbol, sameSymbol } from '../core/symbols';
import { readDecision } from '../journal/journal';
import { latestPositionReview, evaluatePremises } from '../journal/thesis';
import type { Evidence } from '../journal/evidence';
import type { CandidateReview } from './decisionFollowup';
import type { ResearchItem } from '../collect/research';
import { getRequest } from '../core/requests';
import { getPolicyHash } from '../policy/load';

/** A read-only view of decisions, broker fills and events, including their saved queue state. */
export function activityHistory(opts: { type: string; query: string; offset: number; limit: number }) {
  const actions = new Map(getAllActions().map(action => [action.id, action]));
  const brokerFills = readFills();
  const confirmedExits = new Set(brokerFills.filter(fill => fill.side === 'sell').map(fill => `${fill.orderId}:${fill.symbol}`));
  const transitions = new Map<string, ReturnType<typeof readActionHistory>>();
  for (const event of readActionHistory()) {
    const list = transitions.get(event.action.id) ?? [];
    list.push(event);
    transitions.set(event.action.id, list);
  }
  const decisions = readDecisions().map(record => ({
    id: `decision:${record.id}`, type: 'decision', at: record.at,
    symbol: record.symbol, kind: record.kind,
    status: record.orderStatus ?? (record.executed
      ? record.actor === 'broker' && record.kind === 'exit' && confirmedExits.has(`${record.orderId}:${record.symbol}`) ? 'reconciled fill' : 'recorded outcome'
      : record.kind === 'hold' ? 'no action' : 'recorded'),
    reason: record.rationale, record,
    action: record.actionId ? actions.get(record.actionId) ?? null : null,
    transitions: record.actionId ? transitions.get(record.actionId) ?? [] : [],
  }));
  const fills = brokerFills.map(record => ({
    id: `fill:${record.execId}`, type: 'fill', at: record.at,
    symbol: record.symbol, kind: record.side, status: 'filled', reason: 'Confirmed broker execution', record,
  }));
  // Escalations reuse the event ID. Show the latest report once, including events no longer queued.
  const latestEvents = new Map<string, TriggerEvent>();
  for (const event of readAlertLog()) {
    const previous = latestEvents.get(event.id);
    if (!previous || event.wakeCount >= previous.wakeCount) latestEvents.set(event.id, event);
  }
  // Do not call getPendingEvents here: it can reconcile actions and mutate event handling.
  const pending = readValue<{ pending: TriggerEvent[] }>('eventRegistry')?.pending ?? [];
  for (const event of pending) latestEvents.set(event.id, event);
  const queued = new Set(pending.map(event => event.id));
  const events = [...latestEvents.values()].map(record => ({
    id: `event:${record.id}`, type: 'event', at: record.firedAt,
    symbol: record.symbol, kind: record.kind,
    status: record.handling?.replaceAll('_', ' ') ?? (record.ackDisposition === 'ignoring' ? 'declined'
      : record.ackDisposition === 'acting' ? 'action pending'
      : record.ackDisposition === 'acknowledged' ? 'observed' : record.ackedAt ? 'handled' : 'unreviewed'),
    queued: queued.has(record.id), reason: record.headline, record,
  }));
  const query = opts.query.trim().toLowerCase();
  const entries = [...decisions, ...fills, ...events]
    .filter(entry => (opts.type === 'all' || entry.type === opts.type) && (!query || JSON.stringify(entry).toLowerCase().includes(query)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
  return {
    entries: entries.slice(opts.offset, opts.offset + opts.limit), total: entries.length,
    decisions: decisions.length, fills: fills.length, events: events.length,
    offset: opts.offset, limit: opts.limit,
  };
}

/** These dashboard projections only read saved records and the engine's existing tick. */
export function positionProtection(symbol: string) {
  const tick = getLastTick(), snapshot = getPositionSnapshot(symbol);
  const holding = Object.values(tick?.positions ?? {}).find(p => sameSymbol(p.symbol, symbol));
  const tickAge = tick ? Date.now() - Date.parse(tick.tickAt) : NaN;
  const known = Number.isFinite(tickAge) && tickAge >= -30_000 && tickAge <= 180_000
    && !tick?.positionsStale && !tick?.ordersStale && !!holding;
  const stop = known ? tick?.orders?.find(o => o.id === snapshot?.stopOrderId
    && sameSymbol(o.symbol, symbol) && o.side === 'sell' && o.type === 'stop') : undefined;
  const target = known ? tick?.orders?.find(o => o.id === snapshot?.takeProfitOrderId
    && sameSymbol(o.symbol, symbol) && o.side === 'sell' && o.type === 'limit') : undefined;
  const coveredQty = known && snapshot ? (stop ? Math.max(0, stop.qty - stop.filled) : 0) : null;
  return { known, checkedAt: tick?.tickAt ?? null, managed: !!snapshot, holdingQty: holding?.qty ?? null,
    coveredQty, fullyCovered: coveredQty != null && holding ? coveredQty >= holding.qty : null,
    stopPrice: stop?.stopPrice ?? null, stopOrderId: stop?.id ?? null,
    targetPrice: target?.limitPrice ?? null, targetOrderId: target?.id ?? null,
    intendedStop: snapshot?.stopLevel ?? null, intendedTarget: snapshot?.takeProfitLevel ?? null };
}

export function latestCandidateAssessments() {
  const latest = new Map<string, CandidateReview>();
  for (const { value } of listRecords<CandidateReview>('candidate-reviews', { desc: true })) {
    const symbol = canonicalSymbol(value.symbol);
    if (!latest.has(symbol)) latest.set(symbol, value);
  }
  return latest;
}

export function savedPositionContext(symbol: string) {
  const tick = getLastTick(), age = tick ? Date.now() - Date.parse(tick.tickAt) : NaN;
  const holdingKnown = Number.isFinite(age) && age >= -30_000 && age <= 180_000 && !tick?.positionsStale;
  const holding = holdingKnown ? Object.values(tick?.positions ?? {}).find(p => sameSymbol(p.symbol, symbol)) ?? null : null;
  const held = holdingKnown ? holding !== null : null;
  const snapshot = held === false ? undefined : getPositionSnapshot(symbol), entryId = snapshot?.entryDecisionId ?? null;
  const candidate = latestCandidateAssessments().get(canonicalSymbol(symbol)) ?? null;
  const review = snapshot ? latestPositionReview(symbol) : null;
  const entry = entryId ? readDecision(entryId) : null;
  // An old holding in the same symbol must not supply the current entry's observations.
  const openedAt = snapshot?.openedAt ? Date.parse(snapshot.openedAt) : NaN;
  const observation = listRecords<Evidence>('evidence', { desc: true, limit: 1, where: e =>
    e.tool === 'get_position_review' && !!e.symbol && sameSymbol(e.symbol, symbol)
    && (snapshot || held === true ? (e.data.entryDecisionId ?? null) === entryId && !!e.data.holding
      && (!Number.isFinite(openedAt) || Date.parse(e.recordedAt) >= openedAt)
      : e.data.positionKnown === true && !e.data.holding) })[0]?.value ?? null;
  const assessment = snapshot ? review : held === false ? candidate : null;
  const assessmentObservation = assessment?.snapshotId
    ? readRecord<Evidence>('evidence', assessment.snapshotId) ?? null : null;
  const candidateThesisStatus = held === false && candidate?.thesis
    ? evaluatePremises(candidate.thesis, assessmentObservation?.data.metrics ?? {}) : null;
  const savedPlan = held === false && candidate?.entryPlanId ? readRecord<Evidence>('evidence', candidate.entryPlanId) : null;
  const candidateEntryPlan = savedPlan?.tool === 'get_entry_plan' && savedPlan.symbol && sameSymbol(savedPlan.symbol, symbol) ? savedPlan : null;
  // Web searches have no ticker tag. Include sources actually linked through the
  // entry/review's saved observations rather than pretending every search is about this symbol.
  const sourceIds = new Set<string>();
  for (const id of new Set([...(entry?.observationIds ?? []), ...(assessment?.evidenceIds ?? [])])) {
    const e = readRecord<Evidence>('evidence', id)?.data;
    if (!e) continue;
    if (typeof e.sourceId === 'string') sourceIds.add(e.sourceId);
    for (const rows of [e.items, e.filings, e.results]) {
      if (Array.isArray(rows)) for (const row of rows) {
        const sourceId = row?.sourceId ?? row?.id;
        if (typeof sourceId === 'string') sourceIds.add(sourceId);
      }
    }
  }
  const sources = listRecords<ResearchItem>('research-items', { desc: true,
    where: r => (!!r.symbol && sameSymbol(r.symbol, symbol)) || sourceIds.has(r.id) });
  const research = sources.slice(0, 12).map(({ value }) => ({ ...value,
    read: !!readRecord('source-text', value.id),
    review: listRecords<{ sourceId: string; assessment: string; affectedPremise: string; reason: string; at: string }>(
      'research-reviews', { desc: true, limit: 1, where: r => r.sourceId === value.id })[0]?.value ?? null }));
  return { symbol: canonicalSymbol(symbol), managed: !!snapshot, held, holdingKnown, holding, entry: entry ?? null, positionSnapshot: snapshot ?? null,
    review, candidateReview: candidate, observation, assessmentObservation, candidateThesisStatus, candidateEntryPlan,
    protection: positionProtection(symbol), research, researchTotal: sources.length,
    policyHash: getPolicyHash(), savedAt: new Date().toISOString() };
}

export function savedTaskDetails(id: string) {
  const request = getRequest(id);
  if (!request) return null;
  const actions = getAllActions().filter(a => a.requestId === id || request.actionIds?.includes(a.id));
  const actionIds = new Set(actions.map(a => a.id));
  const decisions = readDecisions().filter(d => d.requestId === id || (d.actionId && actionIds.has(d.actionId)));
  const orders = new Set(actions.filter(a => a.result?.orderId && ['entry','exit'].includes(a.kind))
    .map(a => `${a.result!.orderId}:${canonicalSymbol(a.symbol)}:${a.kind === 'entry' ? 'buy' : 'sell'}`));
  const fills = readFills().filter(f => orders.has(`${f.orderId}:${canonicalSymbol(f.symbol)}:${f.side}`));
  const calls = listRecords<any>('tool-calls', { where: c => c.requestId === id });
  const transitions = readActionHistory().filter(event => actionIds.has(event.action.id));
  const transcript = readRecord<any>('transcripts', id);
  return { request, actions, transitions: transitions.slice(-100), decisions: decisions.slice(-100), fills: fills.slice(-100),
    tools: calls.slice(-100).map(r => ({ id: r.id, name: r.value.name, input: r.value.input,
      startedAt: r.value.startedAt ?? r.at, finishedAt: r.value.finishedAt ?? null, resultSaved: r.value.result !== undefined })),
    transcript: transcript ? { status: transcript.status, rounds: transcript.rounds,
      inTokens: transcript.inTokens, outTokens: transcript.outTokens, error: transcript.error ?? null } : null,
    children: listRecords<any>('requests', { where: r => r.parentId === id, desc: true, limit: 50 }).map(r => r.value),
    totals: { tools: calls.length, decisions: decisions.length, fills: fills.length, transitions: transitions.length } };
}
