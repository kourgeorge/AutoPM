import crypto from 'crypto';
import { getPolicy, getPolicyHash } from '../policy/load';
import type { DecisionInput, DecisionRecord } from './types';
import type { Order } from '../state/state';
import { canonicalSymbol } from '../core/symbols';
import { appendRecord, readRecord, saveRecord, listRecords, transaction } from '../core/storage';
import { agentContext, assertAgentActive } from '../core/agentContext';
import { getLastTick } from '../features/lastTick';

let ephemeral = false;
export function useEphemeralJournal(): void { ephemeral = true; }

/** Fields an order row already holds. A decision that placed an order reads them from it. */
const FROM_ORDER = ['symbol', 'rationale', 'triggerEventId', 'qty', 'price', 'intendedPrice', 'intendedStop', 'intendedTarget',
  'atrAtEntry', 'brokerOrderId', 'orderStatus', 'requestedQty', 'filledQty', 'fillPrice', 'thesis', 'observationIds', 'contextVariant', 'policyHash', 'requestId', 'actorId'] as const;

/** What is written: no copies of the order, and no empty fields. */
function stored(record: Partial<DecisionRecord>): Partial<DecisionRecord> {
  const order = record.orderId != null;
  return Object.fromEntries(Object.entries(record).filter(([key, value]) => value != null
    && !(order && ((FROM_ORDER as readonly string[]).includes(key) || (key === 'executed' && ['entry', 'exit'].includes(record.kind!))))));
}

/** Fields every reader expects to see, null when the row leaves them out. */
const EMPTY = { symbol: null, triggerEventId: null, qty: null, price: null, intendedStop: null, intendedTarget: null,
  atrAtEntry: null, brokerOrderId: null, vetoRule: null, venueMessage: null, venueStopId: null, venueStopMissing: null, pnl: null };

/** A journal row as readers see it: an order decision with the order's plan, reason and result. */
function withOrder(row: DecisionRecord): DecisionRecord {
  const record: DecisionRecord = { ...EMPTY, ...row };
  const order = row.orderId ? readRecord<Order>('orders', row.orderId) : undefined;
  if (!order) return record;
  const p = order.params as Record<string, any>, trade = order.kind === 'entry' || order.kind === 'exit';
  const filled = order.result?.filledQty ?? 0, fillPrice = order.result?.filledPrice ?? null;
  return { ...record, symbol: order.symbol, rationale: order.reason, triggerEventId: order.eventId,
    orderStatus: order.status, requestedQty: order.result?.qty ?? p.maxQty ?? p.qty ?? null, filledQty: filled, fillPrice,
    qty: trade ? filled : null, price: trade && filled > 0 ? fillPrice : null, brokerOrderId: order.result?.brokerOrderId ?? null,
    intendedPrice: p.price ?? null, intendedStop: p.stopLoss ?? null, intendedTarget: p.takeProfit ?? null, atrAtEntry: p.atr ?? null,
    thesis: order.kind === 'entry' ? p.thesis : undefined, observationIds: p.observationIds, contextVariant: p.contextVariant,
    policyHash: order.policyHash, requestId: order.requestId, actorId: order.requestedBy,
    executed: trade ? filled > 0 : record.executed };
}

/**
 * Each trend signal's score for `symbol` in the latest tick, or undefined when no tick has
 * scored it. Saved on entries so closed trades can be graded per signal (learning/loop.ts).
 */
export function signalsNow(symbol: string | null | undefined): Record<string, number> | undefined {
  if (!symbol) return undefined;
  const wanted = canonicalSymbol(symbol);
  const row = Object.values(getLastTick()?.watchlist ?? {}).find(w => canonicalSymbol(w.symbol) === wanted);
  const scores = Object.fromEntries((row?.signals ?? []).filter(s => Number.isFinite(s.score)).map(s => [s.name, s.score]));
  return Object.keys(scores).length ? scores : undefined;
}

export function recordDecision(input: DecisionInput, id: string = crypto.randomUUID()): DecisionRecord {
  assertAgentActive();
  const context = agentContext.getStore();
  if (input.kind === 'entry' && input.signalsAtEntry === undefined) {
    const symbol = input.symbol ?? (input.orderId && !ephemeral ? readRecord<Order>('orders', input.orderId)?.symbol : undefined);
    input = { ...input, signalsAtEntry: signalsNow(symbol) };
  }
  const record = { requestId: context?.requestId, actorId: context?.actorId, ...input, id, at: new Date().toISOString() };
  if (ephemeral) return record;
  appendRecord('journal', record.id, record.at, stored(record));
  return readDecision(record.id)!;
}

export function readDecision(id: string): DecisionRecord | undefined {
  if (ephemeral) return undefined;
  const row = readRecord<DecisionRecord>('journal', id);
  return row && withOrder(row);
}

/** Update what the journal alone knows (protection, guard and venue messages); writes nothing when it is unchanged. */
export function recordDecisionOutcome(id: string, patch: Partial<DecisionRecord>): void {
  if (ephemeral) return;
  transaction(() => {
    const current = readRecord<DecisionRecord>('journal', id);
    if (!current) throw new Error('Missing decision for broker outcome: ' + id);
    const next = stored({ ...current, ...patch, id: current.id, at: current.at });
    if (JSON.stringify(next) !== JSON.stringify(stored(current))) saveRecord('journal', id, next);
  });
}

export function readDecisions(opts: { symbol?: string; limit?: number; filter?: (r: DecisionRecord) => boolean } = {}): DecisionRecord[] {
  if (ephemeral) return [];
  const matches = (r: DecisionRecord) => (!opts.symbol || (r.symbol != null && canonicalSymbol(r.symbol) === canonicalSymbol(opts.symbol))) && (!opts.filter || opts.filter(r));
  // Newest matches first, then back into oldest-first order.
  return listRecords<DecisionRecord>('journal', { desc: true }).map(r => withOrder(r.value)).filter(matches).slice(0, opts.limit).reverse();
}

/** Every decision, newest first in journal order, for paging backwards by id. */
export function readDecisionsNewestFirst(): DecisionRecord[] {
  if (ephemeral) return [];
  return listRecords<DecisionRecord>('journal', { desc: true }).map(r => withOrder(r.value));
}

export function decision(
  kind: DecisionRecord['kind'],
  actor: DecisionRecord['actor'],
  fields: Partial<DecisionInput> & { rationale: string },
): DecisionInput {
  return {
    kind,
    actor,
    symbol: null,
    triggerEventId: null,
    executed: false,
    qty: null,
    price: null,
    intendedStop: null,
    intendedTarget: null,
    atrAtEntry: null,
    brokerOrderId: null,
    vetoRule: null,
    venueMessage: null,
    venueStopId: null,
    venueStopMissing: null,
    pnl: null,
    policyVersion: getPolicy().version,
    policyHash: getPolicyHash(),
    ...fields,
  };
}
