import fs from 'fs';
import path from 'path';
import { logger } from '../core/logger';
import { writeFileAtomic } from '../core/fsAtomic';
import { canonicalSymbol } from '../core/symbols';
import { DATA_DIR, ensureDataDir } from '../core/paths';

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
 *
 * `sessionHigh` / `sessionLow` widen and never narrow, so they have NO PATH BACK: a bad
 * price is permanent for the life of the position. Do not add a startup pass that narrows
 * them against daily bars — one existed (`state/repair.ts`, removed) and it could not work,
 * because the vendor's daily series carries no bar for the current day until well after the
 * close. Any position touched today is therefore judged against yesterday's range, and a
 * genuine intraday extreme reads as impossible; on a live book it wanted to erase UBER's
 * real low on the day the position opened. Bars bound these figures, they do not measure
 * them. Fix bad prices at the source (`collect/priceSource.ts`), or derive MFE/MAE from
 * minute bars since `openedAt` and stop storing them at all.
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

  /**
   * When the trader was last shown the shape of the whole book, ISO.
   *
   * Compared by ET DATE, not by value: there is one `portfolio_review` per session close, and
   * the close is an event on the exchange's calendar. Slicing the ISO string would put a
   * 20:00 ET close on the following UTC day for half the year, so `etDate` does the comparing.
   *
   * Empty means never reviewed, and unlike `lastReviewedExitAt` the first run ANNOUNCES rather
   * than adopts. There is no backlog to suppress — the event describes the book as it stands
   * right now — so adopting would skip the first close and gain nothing for it.
   *
   * `resetDailyState` must never clear this. The watermark outlives the day it describes.
   */
  lastPortfolioReviewAt: string;
}

// ── Persistence ───────────────────────────────────────────────────────────────

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DEBOUNCE_MS = 5_000;

const DEFAULT_STATE: SystemState = {
  startOfDayEquity: 0,
  lastResetDate: '',
  positionSnapshots: {},
  eventCooldowns: {},
  armedTriggers: [],
  lastReviewedExitAt: '',
  lastPortfolioReviewAt: '',
};

let _state: SystemState = { ...DEFAULT_STATE };
let _writeTimer: ReturnType<typeof setTimeout> | null = null;
let _ephemeral = false;

/**
 * Re-key the snapshot map to canonical symbols.
 *
 * Needed because the map was written with whatever string the caller held: an order placed
 * as `BTC/USD` stored `BTC/USD`, and every lookup against the venue's `BTCUSD` missed. The
 * spread in `loadFromDisk` merges the TOP level only, so nothing has ever normalised the
 * individual entries.
 *
 * On a collision the later entry wins field by field and the earlier one fills the gaps, so
 * a stop level recorded under one spelling is never dropped in favour of an entry that has
 * none.
 */
function canonicaliseSnapshots(
  raw: Record<string, PositionSnapshot> | undefined,
): Record<string, PositionSnapshot> {
  const out: Record<string, PositionSnapshot> = {};
  for (const [key, snap] of Object.entries(raw ?? {})) {
    if (!snap || typeof snap !== 'object') continue;
    // `symbol` keeps the spelling it was written with — it is the label; the key is the join.
    const withSymbol: PositionSnapshot = { ...snap, symbol: snap.symbol ?? key };
    const canon = canonicalSymbol(withSymbol.symbol);
    const prior = out[canon];
    out[canon] = prior ? { ...prior, ...stripUndefined(withSymbol) } : withSymbol;
  }
  return out;
}

function stripUndefined(snap: PositionSnapshot): Partial<PositionSnapshot> {
  return Object.fromEntries(
    Object.entries(snap).filter(([, v]) => v !== undefined && v !== null),
  ) as Partial<PositionSnapshot>;
}

function loadFromDisk(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = { ...DEFAULT_STATE, ...JSON.parse(raw) };
      _state = { ...parsed, positionSnapshots: canonicaliseSnapshots(parsed.positionSnapshots) };
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
      ensureDataDir();
      // Atomic: this rewrites the whole file on every debounce, and `loadFromDisk` treats an
      // unparseable one as "start fresh" — which would silently discard every position
      // snapshot, stop included. A truncated write is the one failure it cannot detect.
      writeFileAtomic(STATE_FILE, JSON.stringify(_state, null, 2));
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
  const merged = { ...DEFAULT_STATE, ...seed };
  _state = { ...merged, positionSnapshots: canonicaliseSnapshots(merged.positionSnapshots) };
}

export function updateState(patch: Partial<SystemState>): void {
  _state = { ..._state, ...patch };
  scheduleSave();
}

/** The snapshot for a symbol in any spelling — `BTC/USD` and `BTCUSD` find the same record. */
export function getPositionSnapshot(symbol: string): PositionSnapshot | undefined {
  return _state.positionSnapshots[canonicalSymbol(symbol)];
}

/**
 * Record a fill that OPENED a position: the new entry's baselines win.
 *
 * It used to be the reverse — `existing ?? snap` — on the theory that a second open is an
 * add to a live position whose original entry must not be reset. But `enterPosition`'s
 * `already_holding` guard runs first and refuses exactly that, so by the time this is
 * called the venue has just told us there was no position in this symbol. Any snapshot
 * still sitting here is therefore a leftover from a CLOSED trade, and leftovers are a
 * documented fact of this system — so the old branch silently gave the new position the
 * previous trade's `entryPrice`, `stopLevel` and `openedAt`, and every stop, drawdown and
 * P&L figure derived from them was wrong for as long as it was held.
 *
 * The narrower invariant still holds: baselines are written once per position and never
 * overwritten *during* it. Nothing calls this mid-position — `patchPositionSnapshot` and
 * `upsertPositionSnapshot` are the in-life write paths.
 */
export function openPositionSnapshot(snap: PositionSnapshot): void {
  const key = canonicalSymbol(snap.symbol);
  const existing = _state.positionSnapshots[key];
  if (existing) {
    logger.warn(
      `[State] Replacing a stale ${key} snapshot (opened ${existing.openedAt ?? 'unknown'}, ` +
        `entry ${existing.entryPrice ?? 'unknown'}) with the baselines of the entry just filled`,
    );
  }
  _state.positionSnapshots = { ..._state.positionSnapshots, [key]: snap };
  scheduleSave();
}

/** Merge a partial update into an existing snapshot. No-op if the symbol is unknown. */
export function patchPositionSnapshot(
  symbol: string,
  patch: Partial<Omit<PositionSnapshot, 'symbol'>>,
): void {
  const key = canonicalSymbol(symbol);
  const existing = _state.positionSnapshots[key];
  if (!existing) return;
  _state.positionSnapshots = {
    ..._state.positionSnapshots,
    [key]: { ...existing, ...patch },
  };
  scheduleSave();
}

/**
 * Merge a partial update in, creating the snapshot when the symbol is unknown.
 *
 * The create half is the whole point. `patchPositionSnapshot` refuses to create, and
 * `openPositionSnapshot` refuses to overwrite, so a position this system did not open had
 * no write path at all: the retrofit tool wrote through the patch, hit its early return,
 * and still reported success. Nothing recorded the stop, and the stop detector saw a
 * position with no level to watch.
 */
export function upsertPositionSnapshot(
  symbol: string,
  patch: Partial<Omit<PositionSnapshot, 'symbol'>>,
): void {
  const key = canonicalSymbol(symbol);
  const existing = _state.positionSnapshots[key];
  _state.positionSnapshots = {
    ..._state.positionSnapshots,
    [key]: { ...(existing ?? { symbol }), ...patch, symbol: existing?.symbol ?? symbol },
  };
  scheduleSave();
}

export function removePositionSnapshot(symbol: string): void {
  const { [canonicalSymbol(symbol)]: _, ...rest } = _state.positionSnapshots;
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
