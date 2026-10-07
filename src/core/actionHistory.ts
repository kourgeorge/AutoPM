import crypto from 'crypto';
import type { Action, ActionStatus } from '../state/state';
import { appendRecord, readRecords } from './storage';
interface ActionHistoryEntry { at: string; transition: ActionStatus | 'created'; action: Action }
let ephemeral = false;
export function useEphemeralActionHistory(): void { ephemeral = true; }
export function appendActionHistory(action: Action, transition: ActionStatus | 'created'): void {
  if (ephemeral) return;
  const entry = { at: new Date().toISOString(), transition, action };
  appendRecord('action-history', crypto.randomUUID(), entry.at, entry);
}
export function readActionHistory(opts: { limit?: number } = {}): ActionHistoryEntry[] {
  if (ephemeral) return [];
  return readRecords('action-history', opts.limit);
}
