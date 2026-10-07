import crypto from 'crypto';
import { getPolicy, getPolicyHash } from '../policy/load';
import type { DecisionInput, DecisionRecord } from './types';
import { canonicalSymbol } from '../core/symbols';
import { appendRecord, readRecords, readRecord, saveRecord, listRecords, transaction } from '../core/storage';
import { agentContext, assertAgentActive } from '../core/agentContext';

let ephemeral = false;
export function useEphemeralJournal(): void { ephemeral = true; }

export function recordDecision(input: DecisionInput, id: string = crypto.randomUUID()): DecisionRecord {
  assertAgentActive();
  const context = agentContext.getStore();
  const record = { requestId: context?.requestId, actorId: context?.actorId, ...input, id, at: new Date().toISOString() };
  if (!ephemeral) {
    appendRecord('journal', record.id, record.at, record);
  }
  return record;
}

export function readDecision(id: string): DecisionRecord | undefined { return ephemeral ? undefined : readRecord('journal', id); }

/** Update the journal's current outcome; the action audit retains every prior transition. */
export function recordDecisionOutcome(id: string, patch: Partial<DecisionRecord>): void {
  if (ephemeral) return;
  transaction(() => {
    const current = readRecord<DecisionRecord>('journal', id);
    if (!current) throw new Error('Missing decision for broker outcome: ' + id);
    saveRecord('journal', id, { ...current, ...patch, id: current.id, at: current.at });
  });
}

export function readDecisions(opts: { symbol?: string; limit?: number; filter?: (r: DecisionRecord) => boolean } = {}): DecisionRecord[] {
  if (ephemeral) return [];
  const matches = (r: DecisionRecord) => (!opts.symbol || (r.symbol != null && canonicalSymbol(r.symbol) === canonicalSymbol(opts.symbol))) && (!opts.filter || opts.filter(r));
  if (opts.limit !== undefined && (opts.symbol || opts.filter)) {
    // Newest matches first, then back into oldest-first order.
    return listRecords<DecisionRecord>('journal', { where: matches, desc: true, limit: opts.limit }).map(r => r.value).reverse();
  }
  return readRecords<DecisionRecord>('journal', opts.limit).filter(matches);

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
    orderId: null,
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
