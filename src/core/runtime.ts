import { broker } from '../broker';
import { config } from './config';
import { getState, updateState } from '../state/state';
import { transaction } from './storage';

let ready = false;
let lastExecutionAt: string | null = null;
let error: string | null = null;

export async function initializeAccount(): Promise<void> {
  const account = await broker.getAccountInfo();
  if (!account.accountId) throw new Error('Broker did not confirm its account identity');
  const scope = [config.broker, config.venue, account.accountId].join(':');
  transaction(() => {
    const state = getState();
    // data/ holds one account's history; trading another account on top of it would mix them.
    if (state.accountId && state.accountId !== scope) throw new Error(`data/ belongs to ${state.accountId}, but the broker connected ${scope}. Check the broker keys in .env.`);
    if (!state.accountId) updateState({ accountId: scope });
  });
  ready = true;
}

/** Fence every broker mutation: nothing is sent before the account identity is confirmed. */
export function assertExecutionOwner(): void {
  if (!ready) throw new Error('Account is not initialized; broker mutation refused');
}
export function executionHealthy(): void { lastExecutionAt = new Date().toISOString(); error = null; }
export function runtimeFailed(message: string): void { error = message; }
export function runtimeStatus() {
  return { ready: ready && !error, accountId: getState().accountId, lastExecutionAt, error };
}
export function stopRuntime(): void {
  ready = false;
}
