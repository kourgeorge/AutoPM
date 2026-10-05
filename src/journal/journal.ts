import crypto from 'crypto';
import path from 'path';
import { getPolicy, getPolicyHash } from '../policy/load';
import { getState } from '../state/state';
import type { DecisionInput, DecisionRecord } from './types';
import { canonicalSymbol } from '../core/symbols';
import { DATA_DIR } from '../core/paths';
import { appendRecord, importJsonLines, readRecords, readRecord, database, transaction } from '../core/storage';
import { agentContext, assertAgentActive } from '../core/agentContext';

export const JOURNAL_FILE = path.join(DATA_DIR, 'journal.jsonl');
let ephemeral = false;
export function useEphemeralJournal(): void { ephemeral = true; }

export function recordDecision(input: DecisionInput, id: string = crypto.randomUUID()): DecisionRecord {
  assertAgentActive();
  const context = agentContext.getStore();
  const record = { commandId: context?.commandId, actorId: context?.actorId, ...input, id, at: new Date().toISOString() };
  if (!ephemeral) {
    importJsonLines('decision', JOURNAL_FILE);
    appendRecord('decision', record.id, record.at, record);
    appendRecord('decisionIntent', record.id, record.at, record);
  }
  return record;
}

export function readDecision(id: string): DecisionRecord | undefined { return ephemeral ? undefined : readRecord('decision', id); }

/** Update the journal's current outcome; the proposal audit retains every prior transition. */
export function recordDecisionOutcome(id: string, patch: Partial<DecisionRecord>): void {
  if (ephemeral) return;
  transaction(() => {
    const row = database().prepare('SELECT value FROM records WHERE kind=? AND id=?').get('decision', id);
    if (!row) throw new Error('Missing decision for broker outcome: ' + id);
    const current = JSON.parse(row.value);
    database().prepare('UPDATE records SET value=? WHERE kind=? AND id=?')
      .run(JSON.stringify({ ...current, ...patch, id: current.id, at: current.at }), 'decision', id);
  });
}

export function readDecisions(opts: { symbol?: string; limit?: number; filter?: (r: DecisionRecord) => boolean } = {}): DecisionRecord[] {
  if (ephemeral) return [];
  importJsonLines('decision', JOURNAL_FILE);
  const matches = (r: DecisionRecord) => (!opts.symbol || (r.symbol != null && canonicalSymbol(r.symbol) === canonicalSymbol(opts.symbol))) && (!opts.filter || opts.filter(r));
  if (opts.limit !== undefined && (opts.symbol || opts.filter)) {
    const found: DecisionRecord[] = [];
    let before = Number.MAX_SAFE_INTEGER;
    while (found.length < opts.limit) {
      const rows = database().prepare('SELECT seq,value FROM records WHERE kind=? AND seq<? ORDER BY seq DESC LIMIT 200').all('decision', before);
      if (!rows.length) break;
      for (const row of rows) { const record = JSON.parse(row.value); if (matches(record)) found.push(record); }
      before = Number(rows.at(-1).seq);
    }
    return found.slice(0, opts.limit).reverse();
  }
  return readRecords<DecisionRecord>('decision', opts.limit).filter(matches);

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
    accountId: getState().accountId,
    ...fields,
  };
}
