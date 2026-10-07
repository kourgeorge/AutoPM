import { canonicalSymbol } from '../core/symbols';
import { readValue, saveValue, transaction, useEphemeralStorage, forgetEphemeralRecords } from '../core/storage';

export interface PositionSnapshot {
  symbol: string;

  entryPrice?: number;        // set once at fill, NEVER overwritten
  sessionHigh?: number;       // monotonic max since entry (gives MFE)
  sessionLow?: number;        // monotonic min since entry (gives MAE)
  stopLevel?: number;         // absolute price
  takeProfitLevel?: number;   // absolute price
  openedAt?: string;          // ISO
  entryDecisionId?: string;
  managementDecisionId?: string;

  stopOrderId?: string;

  takeProfitOrderId?: string;
}

export type ActionKind = 'entry' | 'exit' | 'stop_adjust' | 'target_adjust';

export type ActionStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'executing' | 'submitted' | 'partial' | 'unknown' | 'executed' | 'failed';

export interface Action {
  id: string;
  kind: ActionKind;
  symbol: string;
  venue: 'paper' | 'live';
  policyHash?: string;
  clientOrderId?: string;
  automatic?: boolean;
  actorId?: string;
  requestId?: string;
  requestedBy?: string;
  toolCallId?: string;
  decisionId?: string;
  params: Record<string, unknown>;
  reason: string;
  eventId: string | null;
  createdAt: number;
  expiresAt: number;
  status: ActionStatus;
  decidedBy: 'human' | 'timeout' | null;
  decidedAt: number | null;
  rejectReason: string | null;
  result: { orderId?: string; qty?: number; filledQty?: number; filledPrice?: number; error?: string } | null;
}

export interface SystemState {
  accountId: string | null;
  paused: boolean;
  dailyLossHalted: boolean;
  startOfDayEquity: number;
  lastResetDate: string;           // YYYY-MM-DD
  positionSnapshots: Record<string, PositionSnapshot>;

  eventCooldowns: Record<string, string>;  // cooldownKey -> ISO lastFiredAt
  armedTriggers: string[];                 // cooldownKeys currently armed

  lastReviewedExitAt: string;

  lastPortfolioReviewAt: string;

  equityPeak: number;

}


const defaults = (): SystemState => ({
  accountId: null, paused: false, dailyLossHalted: false,
  startOfDayEquity: 0, lastResetDate: '', positionSnapshots: {}, eventCooldowns: {},
  armedTriggers: [], lastReviewedExitAt: '', lastPortfolioReviewAt: '', equityPeak: 0,
});
let ephemeral: SystemState | null = null;

function normalize(raw: Partial<SystemState>): SystemState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid saved state');
  const base = defaults();
  const known = Object.fromEntries(Object.entries(raw).filter(([key]) => key in base));
  const state: SystemState = { ...base, ...known };
  for (const key of ['positionSnapshots', 'eventCooldowns'] as const) {
    if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) throw new Error('Invalid state.' + key);
  }
  const snapshots: Record<string, PositionSnapshot> = {};
  for (const [key, snap] of Object.entries(state.positionSnapshots)) {
    if (!snap || typeof snap !== 'object') throw new Error('Invalid position snapshot: ' + key);
    const symbol = snap.symbol ?? key;
    const canonical = canonicalSymbol(symbol);
    const fields = new Set(['symbol','entryPrice','sessionHigh','sessionLow','stopLevel','takeProfitLevel','openedAt','entryDecisionId','managementDecisionId','stopOrderId','takeProfitOrderId']);
    const known = Object.fromEntries(Object.entries(snap).filter(([key]) => fields.has(key)));
    snapshots[canonical] = { ...snapshots[canonical], ...known, symbol };
  }
  return { ...state, positionSnapshots: snapshots };
}

/** The bound broker account is account information (settings.json); the rest is state (state.json). */
export function getState(): Readonly<SystemState> {
  if (ephemeral) return ephemeral;
  const accountId = readValue<{ id: string | null }>('account')?.id ?? null;
  const stored = readValue<SystemState>('state');
  if (stored) return normalize({ ...stored, accountId });
  const initial = normalize({ accountId });
  saveValue('state', { ...initial, accountId: undefined });
  return initial;
}

export function useEphemeralState(seed: Partial<SystemState> = {}): void {
  useEphemeralStorage();
  forgetEphemeralRecords('actions');   // actions used to live in state; each scenario starts with none
  ephemeral = normalize(seed);
}

export function updateState(patch: Partial<SystemState>): void {
  const next = normalize({ ...getState(), ...patch });
  if (ephemeral) { ephemeral = next; return; }
  transaction(() => {
    if (next.accountId !== getState().accountId) saveValue('account', { id: next.accountId });
    saveValue('state', { ...next, accountId: undefined });
  });
}

export function getPositionSnapshot(symbol: string): PositionSnapshot | undefined {
  return getState().positionSnapshots[canonicalSymbol(symbol)];
}

export function openPositionSnapshot(snap: PositionSnapshot): void {
  updateState({ positionSnapshots: { ...getState().positionSnapshots, [canonicalSymbol(snap.symbol)]: snap } });
}

export function patchPositionSnapshot(symbol: string, patch: Partial<Omit<PositionSnapshot, 'symbol'>>): void {
  const existing = getPositionSnapshot(symbol);
  if (existing) openPositionSnapshot({ ...existing, ...patch });
}

export function upsertPositionSnapshot(symbol: string, patch: Partial<Omit<PositionSnapshot, 'symbol'>>): void {
  openPositionSnapshot({ ...(getPositionSnapshot(symbol) ?? { symbol }), ...patch });
}

export function removePositionSnapshot(symbol: string): void {
  const { [canonicalSymbol(symbol)]: removed, ...rest } = getState().positionSnapshots;
  updateState({ positionSnapshots: rest });
}

export function resetDailyState(equity: number, date: string): void {
  updateState({ startOfDayEquity: equity, lastResetDate: date, dailyLossHalted: false });
}
