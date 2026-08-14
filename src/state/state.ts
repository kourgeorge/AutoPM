import fs from 'fs';
import path from 'path';

// ── Interfaces ────────────────────────────────────────────────────────────────

/**
 * Durable per-position baselines.
 *
 * Each field has exactly one job. `lastPrice` used to serve as entry price, last
 * observed price AND alert baseline at once, which is why drop alerts measured
 * from a baseline that ratcheted down with every observation and slow bleeds
 * never fired.
 *
 * Ownership invariant:
 *  - entry baselines (`entryPrice`, `stopLevel`, `takeProfitLevel`, `openedAt`,
 *    `entryDecisionId`) are written ONCE at fill and never again;
 *  - `sessionHigh` / `sessionLow` are advanced only by the L2 feature computation;
 *  - `lastPrice` is purely informational — nothing measures from it.
 */
export interface PositionSnapshot {
  symbol: string;

  entryPrice?: number;        // set once at fill, NEVER overwritten
  sessionHigh?: number;       // monotonic max since entry (gives MFE)
  sessionLow?: number;        // monotonic min since entry (gives MAE)
  stopLevel?: number;         // absolute price
  takeProfitLevel?: number;   // absolute price
  openedAt?: string;          // ISO
  /** Links to the L5 DecisionRecord that opened it — where `atrAtEntry` now lives. */
  entryDecisionId?: string;
}

export interface SystemState {
  startOfDayEquity: number;
  lastResetDate: string;           // YYYY-MM-DD
  positionSnapshots: Record<string, PositionSnapshot>;

  eventCooldowns: Record<string, string>;  // cooldownKey -> ISO lastFiredAt
  armedTriggers: string[];                 // cooldownKeys currently armed

  /**
   * `exitAt` of the newest round trip the trader has already been told about.
   *
   * The watermark that makes `review_ready` fire once per closed trade rather than once per
   * reconcile: round trips are recomputed from the whole fills ledger every time, so without
   * this each run would re-announce all of history. Empty means never watched, and the first
   * run adopts the newest existing exit instead of firing — a backlog nobody has context for
   * is noise, not a lesson.
   */
  lastReviewedExitAt: string;
}

// ── Persistence ───────────────────────────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DEBOUNCE_MS = 5_000;

const DEFAULT_STATE: SystemState = {
  startOfDayEquity: 0,
  lastResetDate: '',
  positionSnapshots: {},
  eventCooldowns: {},
  armedTriggers: [],
  lastReviewedExitAt: '',
};

let _state: SystemState = { ...DEFAULT_STATE };
let _writeTimer: ReturnType<typeof setTimeout> | null = null;
let _ephemeral = false;

function loadFromDisk(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      _state = { ...DEFAULT_STATE, ...JSON.parse(raw) };
    }
  } catch {
    // Corrupted file — start fresh
  }
}

function scheduleSave(): void {
  if (_ephemeral) return;
  if (_writeTimer) return;
  _writeTimer = setTimeout(() => {
    _writeTimer = null;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(_state, null, 2), 'utf8');
    } catch {
      // Non-fatal — in-memory state is always authoritative
    }
  }, DEBOUNCE_MS);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getState(): Readonly<SystemState> {
  return _state;
}

/**
 * Replace the in-memory state with a seed and stop writing to disk, permanently
 * for this process. Test seam for the replay harness.
 *
 * Both halves are load-bearing. Without the seed a replay would inherit whatever
 * positions the live daemon holds; without the write suppression a run that finishes
 * inside the 5s debounce would flush its synthetic fixture over `data/state.json`
 * after the process had already reported success.
 */
export function useEphemeralState(seed: Partial<SystemState> = {}): void {
  _ephemeral = true;
  if (_writeTimer) {
    clearTimeout(_writeTimer);
    _writeTimer = null;
  }
  _state = { ...DEFAULT_STATE, ...seed };
}

export function updateState(patch: Partial<SystemState>): void {
  _state = { ..._state, ...patch };
  scheduleSave();
}

/**
 * Record a fill. Sets the entry baselines when the position is new; when one
 * already exists the quantity accumulates and every baseline is left alone —
 * they describe the original entry, and overwriting them would reset the stop.
 */
export function openPositionSnapshot(snap: PositionSnapshot): void {
  const existing = _state.positionSnapshots[snap.symbol];
  const merged: PositionSnapshot = existing ?? snap;
  _state.positionSnapshots = { ..._state.positionSnapshots, [snap.symbol]: merged };
  scheduleSave();
}

/** Merge a partial update into an existing snapshot. No-op if the symbol is unknown. */
export function patchPositionSnapshot(
  symbol: string,
  patch: Partial<Omit<PositionSnapshot, 'symbol'>>,
): void {
  const existing = _state.positionSnapshots[symbol];
  if (!existing) return;
  _state.positionSnapshots = {
    ..._state.positionSnapshots,
    [symbol]: { ...existing, ...patch },
  };
  scheduleSave();
}

export function removePositionSnapshot(symbol: string): void {
  const { [symbol]: _, ...rest } = _state.positionSnapshots;
  _state.positionSnapshots = rest;
  scheduleSave();
}

/**
 * Re-baseline the trading day. `date` is an ET trading date (`core/time.etDate()`), passed
 * in rather than computed here so the state layer keeps no opinion about calendars.
 */
export function resetDailyState(equity: number, date: string): void {
  _state.startOfDayEquity = equity;
  _state.lastResetDate = date;
  scheduleSave();
}

// Load from disk on module import
loadFromDisk();
