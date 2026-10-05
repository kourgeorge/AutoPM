import crypto from 'crypto';
import { broker } from '../broker';
import { config } from './config';
import { getState, updateState } from '../state/state';
import { readValue, saveValue, transaction, storageHealth } from './storage';

const owner = crypto.randomUUID();
let ready = false;
let lastExecutionAt: string | null = null;
let error: string | null = null;
let heartbeat: ReturnType<typeof setInterval> | undefined;

export async function initializeAccount(): Promise<void> {
  const account = await broker.getAccountInfo();
  if (!account.accountId) throw new Error('Broker did not confirm its account identity');
  if (config.expectedAccount && account.accountId !== config.expectedAccount) throw new Error('ACCOUNT_ID does not match the connected broker account');
  const scope = [config.broker, config.venue, account.accountId].join(':');
  transaction(() => {
    const state = getState();
    if (state.accountId && state.accountId !== scope) throw new Error('DATA_DIR belongs to another broker account or venue; use a separate directory');
    if (!state.accountId && (Object.keys(state.positionSnapshots).length || Object.keys(state.proposals).length) && !config.expectedAccount) {
      throw new Error(
        `Legacy data has no account identity. The connected broker reports ${config.broker}/${config.venue} account ${account.accountId}. ` +
        `If these saved positions/actions belong to that account, set ACCOUNT_ID=${account.accountId} in .env (or your service environment) and restart. ` +
        'Use a separate DATA_DIR for a different account. No trading has started.',
      );
    }
    updateState({ accountId: scope });
    renewLease();
  });
  ready = true;
  clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    try { renewLease(); } catch (err: any) { ready = false; runtimeFailed(err.message); }
  }, 5_000);
  heartbeat.unref();
}

/** Fence every broker mutation, including after a network wait. */
export function assertExecutionOwner(): void {
  const lease = readValue<{ owner: string; until: number }>('workerLease');
  if (!ready || lease?.owner !== owner || lease.until <= Date.now()) {
    throw new Error('Account worker lease is unavailable; broker mutation refused');
  }
}

export function renewLease(): void {
  transaction(() => {
    const lease = readValue<{ owner: string; until: number }>('workerLease');
    if (lease && lease.owner !== owner && lease.until > Date.now()) throw new Error('Another worker owns this account database');
    saveValue('workerLease', { owner, until: Date.now() + 30_000 });
  });
}
export function executionHealthy(): void { lastExecutionAt = new Date().toISOString(); error = null; }
export function runtimeFailed(message: string): void { error = message; }
export function runtimeStatus() {
  const storage = storageHealth();
  return { ready: ready && storage.ok && !error, accountId: getState().accountId, lastExecutionAt, error: error ?? storage.error };
}
export function stopRuntime(): void {
  ready = false;
  clearInterval(heartbeat);
  const lease = readValue<{ owner: string }>('workerLease');
  if (lease?.owner === owner) saveValue('workerLease', null);
}
