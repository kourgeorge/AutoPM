/**
 * L2 — the event bus.
 *
 * Detectors report *levels*; the bus owns the *edges*. That split is the whole point:
 * a level predicate evaluated on a 60s loop fires every tick a position sits 2.1% down,
 * which is a wake storm, not a signal. The bus turns a sequence of level reports into
 * at most one event per crossing, and escalates the ones nobody answered.
 *
 * Five gates, applied in this order per `cooldownKey`:
 *
 *  0. CONFIRM    — a level must be seen breached `confirmTicks` times, without recrossing
 *                  the band in between, before it counts. One reading is not a condition:
 *                  every price-derived level here comes from a single quote, and a single
 *                  bad quote looks exactly like the event. Default 1 — a no-op unless a
 *                  detector asks for confirmation.
 *  1. EDGE       — fire only on a `false -> true` arming transition. Arming lives in
 *                  `state.armedTriggers`, so a restart does not re-announce everything
 *                  the previous process already announced.
 *  2. HYSTERESIS — re-arm requires recrossing the threshold by a band, not merely
 *                  touching it from the other side. Kills boundary flutter.
 *  3. COOLDOWN   — even a re-armed key stays quiet inside `defaultCooldownMs`.
 *  4. ESCALATION — a `critical` event still breaching and still unacked re-fires at
 *                  `criticalCooldownMs` with `wakeCount++`. This is what stands in for
 *                  auto-execution: ignore a stop breach and the wakes get louder.
 *
 * A crossing that recovers past the band publishes `condition_resolved`. Re-arming is
 * otherwise SILENT — the event the trader was woken for simply disappears from the
 * registry — so the all-clear is the one edge in this file that nobody was ever told about.
 *
 * THE BUS ROUTES, IT NEVER DECIDES. `severity` says who is told and how loudly;
 * `suggestedAction` is a suggestion. Nothing here places an order.
 */

import type { Policy } from '../policy/types';
import { getState, updateState } from '../state/state';
import type { TickData } from './compute';

export type EventKind =
  | 'stop_breach'
  | 'take_profit'
  | 'trailing_drawdown'
  | 'position_drop'
  | 'position_surge'
  | 'daily_loss_breach'
  | 'ema_cross_down'
  | 'rsi_exit_zone'
  | 'entry_signal'
  | 'data_stale'
  | 'heartbeat'
  | 'condition_resolved'
  | 'review_ready'
  | 'portfolio_review'
  | 'policy_changed'
  | 'policy_reverted';

/**
 * Who is told, and how loudly. Never what to do.
 *
 *  info     — accumulates into the next cycle context. No wake.
 *  warn     — context + user alert. No wake.
 *  urgent   — wakes the trader.
 *  critical — wakes the trader, alerts the user, and starts the escalation timer.
 */
export type Severity = 'info' | 'warn' | 'urgent' | 'critical';

export type SuggestedAction = 'review' | 'exit' | 'resize' | 'research' | 'reflect';

/**
 * How an event was answered.
 *
 * `ignoring` is deliberately a first-class disposition rather than an absence: the two
 * ways an event can stop escalating are "handled" and "declined", and a system that
 * cannot tell them apart cannot later ask whether the declines were right.
 */
export type AckDisposition = 'acting' | 'acknowledged' | 'ignoring';

/**
 * A level measurement, in whatever units the detector works in.
 *
 * `band` is the re-arm distance expressed in those SAME units. Detectors convert
 * `policy.triggers.hysteresisPct` themselves, because only the detector knows whether
 * it is comparing dollars (stop breach) or percentage points (drawdown) — and a
 * conversion applied in the wrong place is how one side of a comparison ends up wrong.
 */
export interface Crossing {
  level: number;
  threshold: number;
  /** Which side of `threshold` counts as breached. */
  direction: 'above' | 'below';
  band: number;
}

/**
 * A boolean condition expressed as a crossing: fires on `false -> true`, re-arms on
 * `true -> false`.
 *
 * For composite conditions (`emaFast > emaSlow AND rsi >= min`) there is no single scalar
 * to compare, so the condition itself is the level. The band is the full unit step, which
 * is exactly right: a discrete level cannot flutter within a band.
 */
export function boolCrossing(condition: boolean): Crossing {
  return { level: condition ? 1 : 0, threshold: 1, direction: 'above', band: 1 };
}

/**
 * One subject, one tick, from one detector.
 *
 * A detector with a `crossing` should report EVERY subject it evaluated, breached or
 * not: the not-breached reports are what let the bus re-arm. A detector without a
 * `crossing` (heartbeat) is a one-shot — it reports only when it wants to fire, and is
 * paced by the cooldown alone.
 */
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
export type EvidenceValue = number | string | boolean | EvidenceValue[] | { [k: string]: EvidenceValue };

export interface DetectorHit {
  symbol: string | null;
  cooldownKey: string;
  severity: Severity;
  headline: string;
  evidence: Record<string, EvidenceValue>;
  suggestedAction?: SuggestedAction | null;
  crossing?: Crossing;
  /**
   * Override for this key's quiet period. Defaults to `triggers.defaultCooldownMs`.
   * Detectors with their own policy cadence (heartbeat) supply it themselves — nothing
   * else knows which policy field paces them.
   */
  cooldownMs?: number;
  /**
   * Breached readings required before this hit fires, reset by a recross. Default 1.
   *
   * A level computed from ONE reading can be wrong in a way that is indistinguishable from
   * the event itself. Measured: an order book with one side emptied reports the missing
   * side as `0`, so a mid of `(bid + 0) / 2` is half the real price — below any stop, and
   * stamped seconds after the closing print, so the freshness guard passes it. Asking the
   * breach to survive into the next tick costs one tick of latency and rejects the whole
   * class of one-reading artefacts, which no threshold can distinguish from a real move.
   *
   * Only for levels derived from a live reading. A condition computed over a window of bars
   * is already confirmed by its own history; making it wait twice is latency for nothing.
   */
  confirmTicks?: number;
}

export interface Detector {
  kind: EventKind;
  evaluate(data: TickData, policy: Policy): DetectorHit[];
}

export interface TriggerEvent {
  /** `${kind}:${symbol ?? '-'}:${firedAt}` */
  id: string;
  kind: EventKind;
  severity: Severity;
  symbol: string | null;
  firedAt: string;

  /** One line, rendered verbatim to both the LLM and the user. */
  headline: string;
  evidence: Record<string, EvidenceValue>;
  /** Which policy version set the threshold that fired this. */
  policyVersion: number;

  cooldownKey: string;
  suggestedAction: SuggestedAction | null;

  ackedAt: string | null;
  ackDisposition: AckDisposition | null;
  ackNote: string | null;
  /** 1 on first fire, incremented by each escalation. */
  wakeCount: number;
}

// ── Routing ───────────────────────────────────────────────────────────────────

/** Severity that interrupts the trader's sleep. */
export function wakesTrader(e: TriggerEvent): boolean {
  return e.severity === 'urgent' || e.severity === 'critical';
}

/** Severity that reaches the human operator. */
export function alertsUser(e: TriggerEvent): boolean {
  return e.severity === 'warn' || e.severity === 'critical';
}

// ── Live registry ─────────────────────────────────────────────────────────────

/**
 * Events fired and not yet acked, newest last.
 *
 * In memory only. A restart intentionally forgets acks: the arming state persists, so a
 * still-breaching critical re-fires once its escalation window elapses, which is what a
 * fresh process should be told about an open breach.
 */
const pending = new Map<string, TriggerEvent>();

/** cooldownKey -> the live event for that key, for escalation and ack lookup. */
const live = new Map<string, TriggerEvent>();

const MAX_PENDING = 100;

/**
 * cooldownKey -> consecutive breached ticks seen, for gate 0.
 *
 * Deliberately NOT persisted, and deliberately not part of the latch. Every entry is
 * deleted the moment its level stops breaching, so the map only ever holds what is
 * breaching right now — persisting it would put a wholly discardable field on the
 * write-throttled state path to save one tick of latency after a restart. A restart
 * therefore starts the count over, which DELAYS a real breach rather than announcing an
 * unconfirmed one: the safe direction for a gate whose job is rejecting bad readings.
 */
const breachStreak = new Map<string, number>();

export function getPendingEvents(): TriggerEvent[] {
  return [...pending.values()];
}

/**
 * Mark an event answered. Stops escalation for its key; the condition may still hold.
 * Returns false for an unknown or already-acked id.
 *
 * The ack is recorded on the event in `live`, not only removed from `pending`, because the
 * escalation gate reads `live.get(key).ackedAt` — an ack that only deleted the pending
 * entry would leave a still-breaching critical escalating against a `wakeCount` nobody
 * could see the answer to.
 */
export function ackEvent(id: string, disposition?: AckDisposition, note?: string): boolean {
  const event = pending.get(id);
  if (!event) return false;
  event.ackedAt = new Date().toISOString();
  event.ackDisposition = disposition ?? 'acknowledged';
  event.ackNote = note ?? null;
  pending.delete(id);
  return true;
}

/** Test seam. Clears in-memory registries; persisted arming is untouched. */
export function resetEventRegistry(): void {
  pending.clear();
  live.clear();
  breachStreak.clear();
}

// ── The gates ─────────────────────────────────────────────────────────────────

function breached(c: Crossing): boolean {
  return c.direction === 'above' ? c.level >= c.threshold : c.level <= c.threshold;
}

/** Past the threshold by the full band — not merely back on the quiet side of it. */
function recrossed(c: Crossing): boolean {
  return c.direction === 'above'
    ? c.level <= c.threshold - c.band
    : c.level >= c.threshold + c.band;
}

function elapsedSince(iso: string | undefined, now: number): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const then = Date.parse(iso);
  // An unparseable timestamp must not suppress an event forever.
  return Number.isFinite(then) ? now - then : Number.POSITIVE_INFINITY;
}

/**
 * Mutable view of the persisted trigger state for one tick.
 *
 * Collected and written once per tick rather than per event: `updateState` schedules a save
 * on a LEADING-EDGE throttle, so N writes inside one window all land in one file write and
 * the later ones would be indistinguishable from the first — collecting here makes the
 * single write the complete one.
 */
interface TickState {
  cooldowns: Record<string, string>;
  armed: Set<string>;
  dirty: boolean;
}

/**
 * A key is armed when it has never fired, or when it has since recrossed the band.
 *
 * The never-fired case matters: `armedTriggers` starts empty on a fresh `state.json`,
 * and treating empty as "nothing armed" would mean nothing ever fires.
 */
function isArmed(key: string, s: TickState): boolean {
  return !(key in s.cooldowns) || s.armed.has(key);
}

function disarm(key: string, firedAt: string, s: TickState): void {
  s.cooldowns[key] = firedAt;
  s.armed.delete(key);
  s.dirty = true;
}

function rearm(key: string, s: TickState): void {
  if (s.armed.has(key)) return;
  s.armed.add(key);
  s.dirty = true;
}

// ── Publication ───────────────────────────────────────────────────────────────

function makeEvent(
  kind: EventKind,
  hit: DetectorHit,
  firedAt: string,
  policyVersion: number,
  wakeCount: number,
): TriggerEvent {
  return {
    id: `${kind}:${hit.symbol ?? '-'}:${firedAt}`,
    kind,
    severity: hit.severity,
    symbol: hit.symbol,
    firedAt,
    headline: hit.headline,
    evidence: hit.evidence,
    policyVersion,
    cooldownKey: hit.cooldownKey,
    suggestedAction: hit.suggestedAction ?? null,
    ackedAt: null,
    ackDisposition: null,
    ackNote: null,
    wakeCount,
  };
}

/**
 * The all-clear for a crossing that recovered past its band.
 *
 * `info`, not `warn`: this has to reach the next cycle's context and wake nobody, which is
 * exactly where `info` routes. An all-clear that interrupted the trader would cost more
 * attention than the breach did, and one that alerted the operator would announce the end
 * of something they were never told had started (`urgent` does not alert them).
 *
 * Carries its OWN `cooldownKey` so `enqueue` cannot file it under the original's key in
 * `live` — that would hand the escalation gate the all-clear's `wakeCount` of 1 the next
 * time the level breached, resetting a ladder that had climbed to 3.
 *
 * The numbers live in `evidence`, not the headline: a boolean crossing's level is 1-or-0,
 * and printing that as a measurement reads like a price.
 */
function resolveEvent(
  cleared: TriggerEvent,
  hit: DetectorHit,
  firedAt: string,
  policyVersion: number,
): TriggerEvent {
  const answered = cleared.ackedAt ? `answered ${cleared.ackDisposition}` : 'never answered';
  return makeEvent(
    'condition_resolved',
    {
      symbol: cleared.symbol,
      cooldownKey: `resolved:${cleared.cooldownKey}`,
      severity: 'info',
      headline:
        `${cleared.symbol ?? 'portfolio'} ${cleared.kind} cleared — back past the threshold `
        + `by the full band after ${cleared.wakeCount} report(s), ${answered}`,
      evidence: {
        resolvedKind: cleared.kind,
        resolvedEventId: cleared.id,
        firstFiredAt: cleared.firedAt,
        wakeCount: cleared.wakeCount,
        ackDisposition: cleared.ackDisposition ?? 'none',
        level: hit.crossing?.level ?? 'n/a',
        threshold: hit.crossing?.threshold ?? 'n/a',
        originalHeadline: cleared.headline,
      },
      suggestedAction: null,
    },
    firedAt,
    policyVersion,
    1,
  );
}

function enqueue(event: TriggerEvent): void {
  // `info` is a level, not an incident: the newest reading of a key says everything the
  // older ones did. Left to accumulate, an hourly overnight heartbeat puts 16 near-identical
  // lines in front of the LLM by morning. The pile-up is an artefact of `pending` being
  // keyed by `id` while `live` is keyed by `cooldownKey` — so supersede here, where both
  // maps are in hand. An already-acked predecessor is gone from `pending` and nothing
  // needs replacing; warn and above keep accumulating, because each of those IS an incident.
  const prev = live.get(event.cooldownKey);
  if (event.severity === 'info' && prev && pending.has(prev.id)) {
    pending.delete(prev.id);
  }

  pending.set(event.id, event);
  live.set(event.cooldownKey, event);

  // Bound the queue. Oldest first, so a neglected backlog cannot crowd out the event
  // that just fired.
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next();
    if (oldest.done) break;
    pending.delete(oldest.value);
  }
}

/**
 * Publish an event that is ALREADY an edge, bypassing all four gates.
 *
 * The gates exist to turn a level sampled on a 60s loop into at most one event per crossing.
 * Some facts are not levels: a round trip closes once, at a knowable instant, identified by
 * the orders that closed it. There is nothing to recross, so `isArmed` would let it fire
 * exactly once ever, and nothing to flutter, so hysteresis has no meaning. Running such a
 * fact through `processHits` would also write a `cooldowns` entry per occurrence, and keying
 * those by identity is an unbounded leak in `state.json`.
 *
 * THE CALLER OWNS DEDUPLICATION. Nothing here can tell a second announcement of the same
 * fact from a first, so a caller that recomputes its source from a growing file must carry a
 * watermark — see `publishReviewReady`. Do not reach for this for anything a detector can
 * express as a level.
 */
export function publishDiscrete(kind: EventKind, hit: DetectorHit, policy: Policy): TriggerEvent {
  const event = makeEvent(kind, hit, new Date().toISOString(), policy.version, 1);
  enqueue(event);
  return event;
}

/**
 * Run one detector's hits through the four gates.
 *
 * Returns only the events that actually fired this tick — suppressed hits produce
 * nothing, which is the difference between a watcher and a wake storm.
 */
export function processHits(
  kind: EventKind,
  hits: DetectorHit[],
  policy: Policy,
  tick: TickState,
  now: number = Date.now(),
): TriggerEvent[] {
  const fired: TriggerEvent[] = [];
  const firedAt = new Date(now).toISOString();

  for (const hit of hits) {
    const key = hit.cooldownKey;
    const cooldownMs = hit.cooldownMs ?? policy.triggers.defaultCooldownMs;

    // A crossing-less hit is a one-shot: the detector already decided it wants to fire,
    // so the cooldown is the only gate. Arming is deliberately bypassed — there is no
    // level to recross, so an armed-gated one-shot would fire exactly once, ever.
    if (!hit.crossing) {
      if (elapsedSince(tick.cooldowns[key], now) < cooldownMs) continue;

      const event = makeEvent(kind, hit, firedAt, policy.version, 1);
      disarm(key, firedAt, tick);
      enqueue(event);
      fired.push(event);
      continue;
    }

    // A crossing-bearing hit that is not breached is a re-arm opportunity, never an event.
    if (!breached(hit.crossing)) {
      if (recrossed(hit.crossing)) {
        // The confirmation counter resets HERE and not on merely-not-breached, because a
        // level that dips back over the line has not gone away. Hysteresis already made
        // exactly that call for arming, and gate 0 has to use the same boundary: a price
        // straddling its threshold every other tick would otherwise never reach two
        // consecutive breached readings, so a position genuinely sitting on its stop would
        // go unreported forever. It still rejects a single bad reading, because a bad
        // reading is followed by a return to the real price, which is far past the band.
        breachStreak.delete(key);
        rearm(key, tick);
        // `live` holds only keys that actually FIRED, so its presence is the whole dedup:
        // this deletion is what makes the next recrossed tick find nothing to announce.
        const cleared = live.get(key);
        live.delete(key);
        if (cleared) {
          const event = resolveEvent(cleared, hit, firedAt, policy.version);
          enqueue(event);
          fired.push(event);
        }
      }
      continue;
    }

    // Gate 0: the breach must be seen `confirmTicks` times before it counts, and the count
    // survives until the level recrosses the band (see the reset above). Counted before the
    // arming check on purpose — an unconfirmed breach must leave no trace, no cooldown and
    // no latch, so the tick it is finally confirmed on is a clean FIRST fire rather than an
    // escalation of something that never fired.
    //
    // Readings, not elapsed time: a detector that skips a subject — a stale price, a
    // position that vanished — reports nothing for it, so a flickering feed could otherwise
    // never confirm anything. Two readings that both say breached are two confirmations
    // whether they arrived 60 seconds or 20 minutes apart.
    const confirmTicks = Math.max(1, Math.trunc(hit.confirmTicks ?? 1));
    const streak = (breachStreak.get(key) ?? 0) + 1;
    breachStreak.set(key, streak);
    if (streak < confirmTicks) continue;

    if (isArmed(key, tick)) {
      // Gate 3: cooldown applies even to a freshly re-armed key.
      if (elapsedSince(tick.cooldowns[key], now) < cooldownMs) continue;

      const event = makeEvent(kind, hit, firedAt, policy.version, 1);
      disarm(key, firedAt, tick);
      enqueue(event);
      fired.push(event);
      continue;
    }

    // Latched and still breaching. Only a critical escalates; everything else waits for
    // a recross, which is what keeps a persistent warn condition quiet.
    if (hit.severity !== 'critical') continue;

    const previous = live.get(key);
    if (previous?.ackedAt) continue;
    if (elapsedSince(tick.cooldowns[key], now) < policy.triggers.criticalCooldownMs) continue;

    const event = makeEvent(kind, hit, firedAt, policy.version, (previous?.wakeCount ?? 0) + 1);
    disarm(key, firedAt, tick);
    enqueue(event);
    fired.push(event);
  }

  return fired;
}

/**
 * Evaluate every detector against one snapshot and publish the result.
 *
 * The single entry point the scheduler calls. Detector exceptions are contained: a
 * throwing detector must not take down the tick and silence the others alongside it.
 */
export function publishTick(
  detectors: Detector[],
  data: TickData,
  policy: Policy,
  now: number = Date.now(),
): TriggerEvent[] {
  const state = getState();
  const tick: TickState = {
    cooldowns: { ...state.eventCooldowns },
    armed: new Set(state.armedTriggers),
    dirty: false,
  };

  const fired: TriggerEvent[] = [];
  const failures: Array<{ kind: EventKind; error: string }> = [];

  for (const detector of detectors) {
    let hits: DetectorHit[];
    try {
      hits = detector.evaluate(data, policy);
    } catch (err: any) {
      failures.push({ kind: detector.kind, error: err?.message ?? String(err) });
      continue;
    }
    fired.push(...processHits(detector.kind, hits, policy, tick, now));
  }

  if (tick.dirty) {
    updateState({ eventCooldowns: tick.cooldowns, armedTriggers: [...tick.armed] });
  }

  if (failures.length > 0) {
    // Surfaced through the same channel as everything else — a broken detector is a data
    // health problem, and silence about it would be indistinguishable from a calm market.
    const detail = failures.map((f) => `${f.kind}: ${f.error}`).join('; ');
    const firedAt = new Date(now).toISOString();
    const event = makeEvent(
      'data_stale',
      {
        symbol: null,
        cooldownKey: 'detector_failure',
        severity: 'warn',
        headline: `${failures.length} detector(s) threw — ${detail}`,
        evidence: { failed: failures.length },
      },
      firedAt,
      policy.version,
      1,
    );
    enqueue(event);
    fired.push(event);
  }

  return fired;
}

/**
 * Release every trigger latch, returning how many were held.
 *
 * Lives here because this module owns both halves of "the latch": `processHits` writes
 * `eventCooldowns`, `rearm` writes `armedTriggers`, and only one of the two is written on any
 * given path — so a caller that counted one field skipped days where only the other was dirty.
 * The scheduler decides WHEN a day has turned; it should not also have to know which fields
 * constitute the latch, because a third one added here would silently not be released there.
 */
export function releaseAllLatches(): number {
  const state = getState();
  const held = Object.keys(state.eventCooldowns).length + state.armedTriggers.length;
  if (held > 0) updateState({ eventCooldowns: {}, armedTriggers: [] });
  return held;
}
