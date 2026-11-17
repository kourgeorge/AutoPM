/**
 * Tier-3 heartbeat — the periodic look that no threshold can replace.
 *
 * Pure event-driven monitoring misses drift that crosses nothing: a position bleeding 0.3%
 * an hour never trips a detector until it has already tripped the stop. So the LLM always
 * gets a scheduled look at the full snapshot.
 *
 * This is the only detector with NO crossing. It is a one-shot: the bus treats it as
 * cooldown-gated only, and the cadence travels with the hit because nothing outside this
 * file knows which policy field paces it.
 */

import type { Detector, DetectorHit } from '../eventBus';
import type { TickData } from '../compute';
import type { Policy } from '../../policy/types';
import { pctText } from './util';
import { describeGap, investmentGap } from '../../strategy/investment';
import { getPendingEvents } from '../eventBus';
import { isOperatorRequest, listRequests, pendingRequests } from '../../core/requests';
import { getPositionSnapshot } from '../../state/state';
import { sameSymbol } from '../../core/symbols';
import { signalTally } from '../../strategy/signals';
import { etDate } from '../../core/time';
import { logger } from '../../core/logger';

// ── Quiet beats ───────────────────────────────────────────────────────────────
//
// Every waking beat costs a full AI turn. A beat that finds the same book, the same
// protection, the same scan and nothing new to read is recorded as context only and wakes
// nobody. Every other event still wakes the trader exactly as before; only the beat is gated.

/** A held price moved this many ATRs since the last waking beat: worth a look. */
export const PRICE_MOVE_ATR = 0.5;
/** Without an ATR, a move of this many percent counts instead. */
export const PRICE_MOVE_PCT_NO_ATR = 1;
/** Within this many ATRs of the stop or target counts as "near" it. */
export const NEAR_LEVEL_ATR = 1;
/** Without an ATR, within this many percent of the stop or target counts as near. */
export const NEAR_LEVEL_PCT_NO_ATR = 1;
/** How many of the scan's top rows are watched while below the investment target. */
export const SCAN_TOP_N = 5;
/** The scan composite is compared rounded to this step, so noise in the 3rd decimal is no change. */
export const SCAN_COMPOSITE_STEP = 0.1;
/** Longest a beat may stay quiet in regular hours: a beat after this always wakes the trader. */
export const MAX_QUIET_MS_OPEN = 2 * 60 * 60_000;
/** Same, in pre-market and after-hours, where little moves and orders are limits only. */
export const MAX_QUIET_MS_EXTENDED = 4 * 60 * 60_000;
/** Researcher requests looked at for new verdicts. */
const RECENT_RESEARCH = 20;

export interface HeldFingerprint {
  qty: number;
  price: number | null;
  atr: number | null;
  nearStop: boolean | null;
  nearTarget: boolean | null;
  /** True: the managed holding has its stop resting at the broker. Null: unmanaged or unknown this tick. */
  protectedByStop: boolean | null;
}

/** What the trader would look at on a beat. Two equal fingerprints mean the beat has nothing new. */
export interface HeartbeatFingerprint {
  day: string;
  session: string;
  positions: Record<string, HeldFingerprint>;
  /** `SYM:composite` for the scan's top rows; null when at or above the investment target. */
  scanTop: string[] | null;
  /** Pending, unanswered machine events other than heartbeats. */
  eventIds: string[];
  /** Finished researcher requests (their verdicts). */
  researchIds: string[];
  /** Operator requests waiting for the trader. */
  requestIds: string[];
}

/** The parts of a fingerprint that live outside the tick. Read from the stores unless given. */
export interface HeartbeatOutside {
  eventIds: string[];
  researchIds: string[];
  requestIds: string[];
  /** symbol -> has its confirmed stop; null = unknown. Omitted symbols are unmanaged. */
  protection: Record<string, boolean | null>;
}

function near(price: number | null, level: number | null, atr: number | null, side: 'below' | 'above'): boolean | null {
  if (price == null || level == null || !Number.isFinite(price) || !Number.isFinite(level)) return null;
  const gap = side === 'below' ? price - level : level - price;
  if (atr != null && atr > 0) return gap <= NEAR_LEVEL_ATR * atr;
  return price > 0 ? (gap / price) * 100 <= NEAR_LEVEL_PCT_NO_ATR : null;
}

/** Reads the event registry, requests and position snapshots. Any failure reads as "unknown", which wakes. */
export function readHeartbeatOutside(data: Pick<TickData, 'positions' | 'orders' | 'positionsStale' | 'ordersStale'>): HeartbeatOutside | null {
  try {
    const eventIds = getPendingEvents().filter(e => e.kind !== 'heartbeat' && !e.ackedAt).map(e => e.id);
    const researchIds = listRequests(RECENT_RESEARCH)
      .filter(r => r.role === 'researcher' && (r.status === 'completed' || r.status === 'failed')).map(r => r.id);
    const requestIds = pendingRequests('trader').filter(isOperatorRequest).map(r => r.id);
    const protection: Record<string, boolean | null> = {};
    for (const p of Object.values(data.positions ?? {})) {
      if (!p?.symbol) continue;
      const snap = getPositionSnapshot(p.symbol);
      if (!snap) continue; // not managed by the agent
      // Same test as the health panel (`server/status.ts`): a sell stop for the full size.
      protection[p.symbol] = data.positionsStale || data.ordersStale || !data.orders ? null
        : data.orders.some(o => o.id === snap.stopOrderId && sameSymbol(o.symbol, p.symbol) && o.type === 'stop' && o.side === 'sell' && o.qty - o.filled >= p.qty);
    }
    return { eventIds, researchIds, requestIds, protection };
  } catch (err: any) {
    logger.warn(`[Heartbeat] could not read what changed, waking the trader: ${err?.message ?? err}`);
    return null;
  }
}

export function heartbeatFingerprint(data: TickData, policy: Policy, outside: HeartbeatOutside): HeartbeatFingerprint {
  const at = Date.parse(data.tickAt);
  const positions: Record<string, HeldFingerprint> = {};
  for (const [symbol, p] of Object.entries(data.positions ?? {})) {
    const price = p?.price ?? null, atr = p?.atr ?? null;
    positions[symbol] = {
      qty: p?.qty ?? 0, price, atr,
      nearStop: near(price, p?.stopLevel ?? null, atr, 'below'),
      nearTarget: near(price, p?.takeProfitLevel ?? null, atr, 'above'),
      protectedByStop: outside.protection[symbol] ?? null,
    };
  }
  const gap = data.session !== 'closed' ? investmentGap(policy, data.portfolio?.grossDeployedPct) : null;
  const scanTop = gap?.belowTarget
    ? Object.values(data.watchlist ?? {})
      .map(w => ({ symbol: w.symbol, composite: w.signals?.length ? signalTally(w.signals).composite : null }))
      .filter(r => r.composite != null)
      .sort((a, b) => b.composite! - a.composite! || a.symbol.localeCompare(b.symbol))
      .slice(0, SCAN_TOP_N)
      .map(r => `${r.symbol}:${(Math.round(r.composite! / SCAN_COMPOSITE_STEP) * SCAN_COMPOSITE_STEP).toFixed(1)}`)
    : null;
  return {
    day: etDate(new Date(Number.isFinite(at) ? at : Date.now())),
    session: data.session,
    positions, scanTop,
    eventIds: outside.eventIds, researchIds: outside.researchIds, requestIds: outside.requestIds,
  };
}

/** Why this beat should wake the trader, compared with the last beat that did; null = nothing changed. */
export function heartbeatChange(prev: HeartbeatFingerprint, now: HeartbeatFingerprint): string | null {
  if (prev.day !== now.day) return 'new trading day';
  if (prev.session !== now.session) return `session ${prev.session} -> ${now.session}`;
  const held = Object.keys(now.positions), had = Object.keys(prev.positions);
  for (const s of held) if (!(s in prev.positions)) return `new holding ${s}`;
  for (const s of had) if (!(s in now.positions)) return `${s} no longer held`;
  for (const s of held) {
    const a = prev.positions[s], b = now.positions[s];
    if (a.qty !== b.qty) return `${s} quantity ${a.qty} -> ${b.qty}`;
    if (b.price != null) {
      if (a.price == null) return `${s} has a price again`;
      const atr = b.atr ?? a.atr;
      const moved = Math.abs(b.price - a.price);
      if (atr != null && atr > 0 ? moved > PRICE_MOVE_ATR * atr : a.price > 0 && (moved / a.price) * 100 > PRICE_MOVE_PCT_NO_ATR)
        return `${s} moved ${a.price} -> ${b.price}`;
    }
    if (b.nearStop != null && b.nearStop !== a.nearStop) return `${s} ${b.nearStop ? 'near' : 'away from'} its stop`;
    if (b.nearTarget != null && b.nearTarget !== a.nearTarget) return `${s} ${b.nearTarget ? 'near' : 'away from'} its target`;
    if (b.protectedByStop != null && b.protectedByStop !== a.protectedByStop) return `${s} ${b.protectedByStop ? 'stop confirmed' : 'stop missing'}`;
  }
  if ((prev.scanTop ?? []).join(',') !== (now.scanTop ?? []).join(',') || (prev.scanTop == null) !== (now.scanTop == null)) return 'scan top changed';
  // Only NEW items count: an event the trader answered since is not a reason to look again.
  const added = (a: string[], b: string[]) => b.find(id => !a.includes(id));
  const ev = added(prev.eventIds, now.eventIds); if (ev) return `new event ${ev}`;
  const rs = added(prev.researchIds, now.researchIds); if (rs) return `new research ${rs}`;
  const rq = added(prev.requestIds, now.requestIds); if (rq) return `new operator request ${rq}`;
  return null;
}

/** The last beat that woke the trader. In memory: after a restart the first beat always wakes. */
let lastWake: { fingerprint: HeartbeatFingerprint; at: number } | null = null;

/** Tests and the replay harness start every scenario from "never woken". */
export function resetHeartbeatGate(): void { lastWake = null; }

function maxQuietMs(session: string): number {
  return session === 'open' ? MAX_QUIET_MS_OPEN : MAX_QUIET_MS_EXTENDED;
}

function etClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }) + ' ET';
}

/**
 * How long the beat waits between periodic checks for this tick. Also read by the dashboard
 * to count down the trader's next check, so both show the same cadence.
 */
export function heartbeatCadenceMs(data: Pick<TickData, 'account' | 'session' | 'portfolio'>, policy: Policy): number {
  const open = data.session !== 'closed';
  const underInvested = open && !!investmentGap(policy, data.portfolio?.grossDeployedPct)?.belowTarget;
  return (data.account.positionCount > 0 || underInvested) && open
    ? policy.triggers.heartbeatWithPositionsMs
    : policy.triggers.heartbeatFlatMs;
}

export const heartbeatDetector: Detector = {
  kind: 'heartbeat',
  evaluate(data, policy) {
    const a = data.account;
    const holding = a.positionCount > 0;
    const symbols = Object.keys(data.positions);

    // The trader sets no timer of its own, so while orders can trade this beat is what wakes
    // it: every 15 minutes holding, hourly flat. That includes pre-market and after-hours,
    // where entries and exits go out as extended-hours limits. 20:00–04:00 nothing can trade,
    // so the beat is context only — ungated it meant 96 unactionable cycles a night.
    //
    // Clock-only like the session itself: a holiday reads as tradable here, and the order
    // guard (which asks the venue calendar) is what refuses.
    const open = data.session !== 'closed';
    // Below the profile's investment target there is work to do even with nothing held, so
    // the beat runs at the holding cadence. Flat used to mean hourly — the less it had
    // invested, the less often it looked for something to buy.
    const gap = investmentGap(policy, data.portfolio?.grossDeployedPct);
    const underInvested = open && !!gap?.belowTarget;

    // While orders can trade, compare with the last beat that woke the trader. Nothing new and
    // not quiet for too long: this beat is context only. Unreadable stores always wake.
    const tickMs = Number.isFinite(Date.parse(data.tickAt)) ? Date.parse(data.tickAt) : Date.now();
    let fingerprint: HeartbeatFingerprint | null = null;
    let quietSince: number | null = null;
    if (open) {
      const outside = readHeartbeatOutside(data);
      fingerprint = outside ? heartbeatFingerprint(data, policy, outside) : null;
      if (fingerprint && lastWake && tickMs - lastWake.at < maxQuietMs(data.session)
        && heartbeatChange(lastWake.fingerprint, fingerprint) === null) quietSince = lastWake.at;
    }
    const quiet = quietSince != null;

    const hit: DetectorHit = {
      symbol: null,
      // One key for both cadences: switching from flat to holding should tighten the beat,
      // not start a second independent one.
      cooldownKey: 'heartbeat',
      severity: open && !quiet ? 'urgent' : 'info',
      headline: (holding
        ? `Periodic check — ${a.positionCount} position(s) open (${symbols.join(', ')}), day P&L ${pctText(a.dayPnLPct)}`
        : `Periodic check — flat, day P&L ${pctText(a.dayPnLPct)}`)
        + (underInvested ? ` — ${gap!.belowFloor ? 'UNDER-INVESTED' : 'below target'}: ${describeGap(gap!)}` : '')
        + (quiet ? ` — nothing changed since ${etClock(quietSince!)}, trader not woken` : ''),
      evidence: {
        positionCount: a.positionCount,
        symbols: symbols.join(',') || 'none',
        dayPnLPct: a.dayPnLPct ?? 'n/a',
        equity: a.equity ?? 'n/a',
        session: data.session,
        ...(gap ? { investedPct: Number(gap.investedPct.toFixed(2)), targetInvestedPct: gap.targetPct ?? 'none', minInvestedPct: gap.floorPct ?? 'none' } : {}),
        ...(quiet ? { quietSince: new Date(quietSince!).toISOString() } : {}),
      },
      suggestedAction: 'review',
      // `heartbeatFlatMs` already means "the slow cadence"; outside market hours that is
      // what a holding heartbeat wants too, so the two regimes reuse the two existing keys.
      cooldownMs: heartbeatCadenceMs(data, policy),
      // Only a beat that actually fired and woke the trader becomes the new reference.
      onFired: open && !quiet ? (event) => {
        lastWake = fingerprint ? { fingerprint, at: Date.parse(event.firedAt) } : null;
      } : quiet ? () => logger.info(`[Heartbeat] nothing changed since ${etClock(quietSince!)}; trader not woken`) : undefined,
    };

    return [hit];
  },
};
