/**
 * The replay harness — the primary verification tier for L2.
 *
 * Drives synthetic `RawBundle`s through the REAL `computeTick` -> `publishTick` path:
 * no broker, no network, no LLM, no clock. Time is a parameter (`publishTick(..., now)`),
 * prices are `Observation` literals, and state is ephemeral, so a run is deterministic
 * and cannot touch `data/state.json`.
 *
 * What it exists to catch is a whole class of bug this codebase was full of: an event that
 * fires every tick, an event that fires exactly once ever, a baseline that ratchets, a
 * threshold compared against the wrong unit, and a dead feed that looks like a calm market.
 * Those are all invisible to `tsc` and expensive to discover live.
 *
 * Assertions are counts of fired events per kind, because a count is the only thing that
 * distinguishes "detected" from "detected once" — and the difference between those two is
 * the entire justification for the event bus.
 *
 *   npm run replay        # summary
 *   npm run replay -- -v  # plus every fired event
 */

import fs from 'fs';
import type { AccountInfo, Position } from '../broker/IBroker';
import type { RawBundle } from '../collect';
import { type Maybe, type Observation, type SourceId, missing } from '../collect/types';
import { etDate } from '../core/time';
import type { Bar, SignalResult } from '../core/types';
import { computeTick, type TickData } from '../features/compute';
import { DETECTORS } from '../features/detectors';
import {
  ackEvent,
  getPendingEvents,
  publishTick,
  resetEventRegistry,
  type EventKind,
  type TriggerEvent,
} from '../features/eventBus';
import { getLastTick, recordTick, resetLastTick } from '../features/lastTick';
import { createLiveRouter } from '../features/router';
import { watchlistScan } from '../features/watchlistScan';
import { ensureDailyReset } from '../features/scheduler';
import {
  JOURNAL_FILE,
  decision,
  readDecisions,
  recordDecision,
  useEphemeralJournal,
} from '../journal/journal';
import { useEphemeralLessons } from '../journal/lessons';
import type { DecisionRecord } from '../journal/types';
import { useEphemeralFillsLedger } from '../review/fillsLedger';
import { getPolicy, parsePolicy, readPolicyText } from '../policy/load';
import type { Policy } from '../policy/types';
import { crossedAbove, ema, rsi } from '../strategy/indicators';
import { GuardRejection, enterPosition } from '../strategy/orderManager';
import {
  getState,
  useEphemeralState,
  type PositionSnapshot,
  type SystemState,
} from '../state/state';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const SOURCE: SourceId = 'alpaca';

/**
 * At module scope, not inside `main()`: the harness exercises the real write sites, so
 * anything that records a decision before this ran would append a synthetic entry to the
 * operator's real journal. Same trap `useEphemeralState` exists to close, one file over,
 * and the only defence is that it is impossible to reach a scenario without passing here.
 */
useEphemeralJournal();
// Nothing here reconciles fills yet. It is here for the moment something does — a scenario
// that reaches `tickOnce` would otherwise splice synthetic executions into the operator's
// real ledger, and the FIFO matcher would report round trips that never happened.
useEphemeralFillsLedger();
// No scenario drives the trader agent, so nothing here can call `write_lesson` today. Same
// reasoning as the ledger above: the cost of the line is nothing, and the cost of the first
// scenario that does reach it is a synthetic rule of thumb the live trader then obeys.
useEphemeralLessons();

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * A fresh observation at virtual time `at`.
 *
 * Built as a literal rather than via `observe()` on purpose: `observe` measures age
 * against the wall clock, so every virtual-time `asOf` would come back `stale: true` and
 * every scenario would silently degrade into scenario 4.
 */
function fresh<T>(value: T, at: Date): Observation<T> {
  const iso = at.toISOString();
  return { value, source: SOURCE, asOf: iso, fetchedAt: iso, stale: false };
}

interface World {
  positions: Position[];
  /** `null` = the feed failed for that symbol this tick. */
  prices: Record<string, number | null>;
  bars?: Record<string, Bar[]>;
  account?: AccountInfo;
  /**
   * The broker's account endpoint failed. Distinct from a dead price feed because the
   * account path is the one staleness signal NOT gated on the session — without a way to
   * fail it here, "the account still reports overnight" is unverifiable, and a regression
   * to total overnight silence would pass the suite.
   */
  accountDown?: boolean;
}

const ACCOUNT: AccountInfo = {
  equity: 100_000, cash: 50_000, buyingPower: 100_000, previousCloseEquity: 100_000,
};

function bundle(world: World, at: Date): RawBundle {
  const prices = new Map<string, Maybe<number>>();
  for (const [symbol, value] of Object.entries(world.prices)) {
    prices.set(
      symbol,
      value === null ? missing(SOURCE, `no quote for ${symbol}`) : fresh(value, at),
    );
  }

  const bars = new Map<string, Maybe<Bar[]>>();
  for (const [symbol, series] of Object.entries(world.bars ?? {})) {
    bars.set(symbol, fresh(series, at));
  }

  return {
    collectedAt: at.toISOString(),
    positions: fresh(world.positions, at),
    account: world.accountDown
      ? missing(SOURCE, 'account endpoint unreachable')
      : fresh(world.account ?? ACCOUNT, at),
    openOrders: fresh([], at),
    prices,
    bars,
  };
}

/**
 * One full tick at virtual time `at`: derive features, run every detector, publish.
 *
 * The snapshot comes back alongside the events because an `EventRouter` takes both — the
 * routing scenarios have to hand over the same snapshot the events were derived from, not
 * a stand-in.
 */
function tickBoth(
  world: World,
  at: Date,
  policy: Policy = getPolicy(),
): { snapshot: TickData; fired: TriggerEvent[] } {
  const snapshot = computeTick(bundle(world, at), policy);
  const fired = publishTick(DETECTORS, snapshot, policy, at.getTime());
  if (VERBOSE) {
    for (const e of fired) {
      console.log(`      ${at.toISOString()} [${e.severity}] ${e.kind} w${e.wakeCount} — ${e.headline}`);
    }
  }
  return { snapshot, fired };
}

function tick(world: World, at: Date, policy: Policy = getPolicy()): TriggerEvent[] {
  return tickBoth(world, at, policy).fired;
}

function position(symbol: string, qty: number, avgCost: number): Position {
  return { symbol, qty, avgCost };
}

function snapshotSeed(
  symbol: string,
  opts: Partial<PositionSnapshot> & { entryPrice: number },
  openedAt: Date,
): PositionSnapshot {
  return {
    symbol,
    openedAt: openedAt.toISOString(),
    ...opts,
    sessionHigh: opts.sessionHigh ?? opts.entryPrice,
    sessionLow: opts.sessionLow ?? opts.entryPrice,
  };
}

/** A flat synthetic bar. Only `c` feeds EMA/RSI; `h`/`l` exist for ATR. */
function bar(close: number, at: number): Bar {
  return { t: new Date(at).toISOString(), o: close, h: close + 0.5, l: close - 0.5, c: close, v: 1_000 };
}

function series(closes: number[], endAt: Date): Bar[] {
  const dayMs = 86_400_000;
  const start = endAt.getTime() - (closes.length - 1) * dayMs;
  return closes.map((c, i) => bar(c, start + i * dayMs));
}

// ── Harness ───────────────────────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];
let currentScenario = '';

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`   PASS  ${label}`);
    return;
  }
  failures.push(`${currentScenario} / ${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`   FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

function countOf(events: TriggerEvent[], kind: EventKind): number {
  return events.filter((e) => e.kind === kind).length;
}

function checkCount(events: TriggerEvent[], kind: EventKind, expected: number): void {
  const actual = countOf(events, kind);
  check(`${kind} fired ${expected}x`, actual === expected, `got ${actual}`);
}

function near(actual: number | null, expected: number, tolerance = 1e-6): boolean {
  return actual !== null && Math.abs(actual - expected) <= tolerance;
}

/** Every scenario starts from a known state, an empty event registry and no stored tick — a
 * leaked cooldown or a leaked snapshot from a previous scenario would make the suite
 * order-dependent. */
async function scenario(
  name: string,
  seed: Partial<SystemState>,
  body: () => void | Promise<void>,
): Promise<void> {
  currentScenario = name;
  console.log(`\n${name}`);
  useEphemeralState({ startOfDayEquity: ACCOUNT.equity, ...seed });
  resetEventRegistry();
  resetLastTick();
  try {
    await body();
  } catch (err: any) {
    failures.push(`${name} / threw — ${err?.message ?? String(err)}`);
    console.log(`   FAIL  threw — ${err?.message ?? String(err)}`);
  }
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

const BASE = new Date('2026-03-02T15:00:00.000Z');
const MIN = 60_000;
const at = (minutes: number) => new Date(BASE.getTime() + minutes * MIN);
const OPENED = new Date(BASE.getTime() - 60 * MIN);

/**
 * 03:00 ET Tuesday — `marketSession()` says `closed`.
 *
 * A second named base rather than a parameter on `at()`: there are exactly two regimes
 * that matter to the detectors, and naming both documents which one a scenario is in.
 */
const NIGHT = new Date('2026-03-03T08:00:00.000Z');
const atNight = (minutes: number) => new Date(NIGHT.getTime() + minutes * MIN);

/**
 * 1. Slow bleed — the case the old alert watcher could not see at all, because its
 *    baseline ratcheted down with every reading. 20 ticks, -0.4% each, never touching
 *    the stop. Each drop kind must fire exactly ONCE, and the heartbeat must fire
 *    exactly TWICE (t+1 and t+16 at a 15-minute cadence) — the regression assertion for
 *    the crossing-less one-shot fix, which previously fired once and then never again.
 */
function slowBleed(): void {
  const all: TriggerEvent[] = [];
  for (let k = 1; k <= 20; k++) {
    const price = 100 * Math.pow(0.996, k);
    all.push(
      ...tick({ positions: [position('AAPL', 10, 100)], prices: { AAPL: price } }, at(k)),
    );
  }

  checkCount(all, 'position_drop', 1);
  checkCount(all, 'trailing_drawdown', 1);
  checkCount(all, 'stop_breach', 0);
  checkCount(all, 'heartbeat', 2);

  // Bounded rather than exact: k=5 is -1.984% (must not fire), k=6 is -2.376%, k=7 is
  // -2.767%. Requiring the fired value to sit in (-2.5, -2.0] pins it to k=6 without
  // hard-coding a float. Firing early means the threshold sign is wrong; firing late
  // means an edge was missed.
  const drop = all.find((e) => e.kind === 'position_drop');
  const firedAtPct = drop?.evidence.pnlPct as number | undefined;
  check(
    'position_drop fired on the first tick past -2.0%',
    firedAtPct !== undefined && firedAtPct <= -2.0 && firedAtPct > -2.5,
    `pnlPct ${firedAtPct}`,
  );
}

/**
 * 2. Flutter — price oscillating either side of the threshold. Without hysteresis this
 *    is one event per tick forever; with it, one event total.
 */
function flutter(): void {
  const all: TriggerEvent[] = [];
  for (let k = 1; k <= 10; k++) {
    // -2.1% / -1.9%: back across the threshold but nowhere near the 0.5pp re-arm band.
    const price = k % 2 === 1 ? 97.9 : 98.1;
    all.push(
      ...tick({ positions: [position('AAPL', 10, 100)], prices: { AAPL: price } }, at(k)),
    );
  }

  checkCount(all, 'position_drop', 1);
  checkCount(all, 'trailing_drawdown', 1);
}

/**
 * 3. Recover, then re-breach. Proves gates 2 and 3 are independent: recrossing the band
 *    re-arms the key, but the cooldown still holds it quiet until it expires.
 */
function recoverThenRebreach(): void {
  const hold = [position('AAPL', 10, 100)];
  const all: TriggerEvent[] = [];

  all.push(...tick({ positions: hold, prices: { AAPL: 97.9 } }, at(0)));   // fire
  all.push(...tick({ positions: hold, prices: { AAPL: 98.6 } }, at(1)));   // -1.4% -> re-arm
  const inCooldown = tick({ positions: hold, prices: { AAPL: 97.9 } }, at(2)); // armed, quiet
  all.push(...inCooldown);
  all.push(...tick({ positions: hold, prices: { AAPL: 97.9 } }, at(20)));  // cooldown done

  checkCount(all, 'position_drop', 2);
  check(
    're-armed key stays quiet inside the cooldown',
    countOf(inCooldown, 'position_drop') === 0,
  );
}

/**
 * 4. Stale feed. A dead quote must produce a `data_stale` event and NOT a stop breach —
 *    and the suppression must end when the feed recovers, or the fix for one bug becomes
 *    permanent silence about another.
 */
function staleFeed(): void {
  const hold = [position('AAPL', 10, 100)];

  const t1 = tick({ positions: hold, prices: { AAPL: 100 } }, at(0));
  const t2 = tick({ positions: hold, prices: { AAPL: null } }, at(1));
  const t3 = tick({ positions: hold, prices: { AAPL: null } }, at(2));
  const t4 = tick({ positions: hold, prices: { AAPL: 95 } }, at(3));

  const down = [...t2, ...t3];
  check('no stop_breach while the feed is dead', countOf(down, 'stop_breach') === 0);
  checkCount(down, 'data_stale', 1);
  check(
    'stop_breach fires as soon as the feed recovers',
    countOf(t4, 'stop_breach') === 1,
    `got ${countOf(t4, 'stop_breach')}`,
  );
  check('a healthy tick fires no data_stale', countOf(t1, 'data_stale') === 0);
}

/**
 * 5. New session high. `sessionHigh` must be durable and monotonic, and the drawdown
 *    must measure from it — so a position 7.5% UP on the day can still raise a drawdown
 *    event, which is impossible for anything measuring from entry.
 */
function newSessionHigh(): void {
  const hold = [position('AAPL', 10, 100)];

  tick({ positions: hold, prices: { AAPL: 110 } }, at(0));
  const stored = getState().positionSnapshots.AAPL;
  check('sessionHigh advanced to 110', stored?.sessionHigh === 110, `got ${stored?.sessionHigh}`);
  check('sessionLow held at entry', stored?.sessionLow === 100, `got ${stored?.sessionLow}`);

  const t2 = tick({ positions: hold, prices: { AAPL: 107.5 } }, at(1));
  const dd = t2.find((e) => e.kind === 'trailing_drawdown');
  check('trailing_drawdown fires off the session high', dd !== undefined);
  check('measured from 110, not entry', dd?.evidence.sessionHigh === 110, `got ${dd?.evidence.sessionHigh}`);
  check(
    'position is UP while drawing down',
    near(dd?.evidence.pnlPct as number, 7.5, 1e-9),
    `pnlPct ${dd?.evidence.pnlPct}`,
  );
}

/**
 * 6. Restart. Arming is persisted, so a fresh process must not re-announce a breach the
 *    previous one already announced. `urgent` is the right severity to assert on: a
 *    `critical` is documented to re-fire after `criticalCooldownMs`, and scenario 9
 *    covers that path.
 */
function restart(): void {
  const hold = [position('AAPL', 10, 100)];
  const first = tick({ positions: hold, prices: { AAPL: 97.5 } }, at(0));
  check('fired before the restart', countOf(first, 'position_drop') === 1);

  const carried = {
    eventCooldowns: { ...getState().eventCooldowns },
    armedTriggers: [...getState().armedTriggers],
    positionSnapshots: { ...getState().positionSnapshots },
  };

  // A new process: in-memory registries gone, persisted arming carried over.
  useEphemeralState({ startOfDayEquity: ACCOUNT.equity, ...carried });
  resetEventRegistry();

  const after = tick({ positions: hold, prices: { AAPL: 97.5 } }, at(20));
  check(
    'restart does not re-announce a latched breach',
    countOf(after, 'position_drop') === 0,
    `got ${countOf(after, 'position_drop')}`,
  );
}

/**
 * 7. Policy edit. The same market against two policies must produce different events,
 *    and every event must carry the version of the policy that fired it — otherwise L5
 *    cannot attribute an outcome to a threshold.
 */
function policyEdit(): void {
  const hold = [position('AAPL', 10, 100)];
  const live = getPolicy();

  const runA = tick({ positions: hold, prices: { AAPL: 97.5 } }, at(0), live);
  checkCount(runA, 'position_drop', 1);
  check(
    'event carries the firing policy version',
    runA.every((e) => e.policyVersion === live.version),
  );

  const edited = parsePolicy(
    readPolicyText()
      .replace(/positionDropPct:\s*[\d.]+/, 'positionDropPct: 3.0')
      .replace(/^version:\s*\d+/m, `version: ${live.version + 1}`),
  );
  if (!edited.ok) {
    check('edited policy parses', false, edited.errors.join('; '));
    return;
  }
  check('edited policy parses', true);

  useEphemeralState({ startOfDayEquity: ACCOUNT.equity });
  resetEventRegistry();

  const runB = tick({ positions: hold, prices: { AAPL: 97.5 } }, at(0), edited.policy);
  checkCount(runB, 'position_drop', 0);

  const only = [...new Set(runA.map((e) => e.kind))].filter(
    (k) => !new Set(runB.map((e) => e.kind)).has(k),
  );
  check(
    'raising the threshold silences exactly position_drop',
    only.length === 1 && only[0] === 'position_drop',
    `differs by ${JSON.stringify(only)}`,
  );
}

/**
 * 8. Immutable violation. A policy edit past an `immutable` ceiling must be REJECTED and
 *    must leave the active policy untouched — the whole point of the reload-never-throws
 *    split is that a bad edit cannot take a running daemon down or quietly widen a limit.
 */
function immutableViolation(): void {
  const before = getPolicy().risk.maxDailyLossPct;
  const ceiling = getPolicy().immutable.maxDailyLossPctCeiling;

  const result = parsePolicy(
    readPolicyText().replace(/maxDailyLossPct:\s*[\d.]+/, `maxDailyLossPct: ${ceiling + 0.04}`),
  );

  check('edit past the ceiling is rejected', result.ok === false);
  check(
    'the error names the offending field',
    result.ok === false && result.errors.some((e) => e.includes('maxDailyLossPct')),
    result.ok === false ? result.errors.join('; ') : '',
  );
  check('active policy is unchanged', getPolicy().risk.maxDailyLossPct === before);
}

/**
 * 9. Escalation ladder — the mechanism that stands in for auto-execution. An unanswered
 *    critical must get LOUDER, and an acked one must go quiet even while still breaching.
 */
function escalation(): void {
  const hold = [position('AAPL', 10, 100)];
  const world = { positions: hold, prices: { AAPL: 95 } };

  const t0 = tick(world, at(0));
  const first = t0.find((e) => e.kind === 'stop_breach');
  check('first breach fires at wakeCount 1', first?.wakeCount === 1, `got ${first?.wakeCount}`);

  const t1 = tick(world, at(1));
  check('no re-fire inside criticalCooldownMs', countOf(t1, 'stop_breach') === 0);

  const t6 = tick(world, at(6));
  const second = t6.find((e) => e.kind === 'stop_breach');
  check('unanswered critical escalates to wakeCount 2', second?.wakeCount === 2, `got ${second?.wakeCount}`);

  check('ack accepted', second !== undefined && ackEvent(second.id));
  const t18 = tick(world, at(18));
  check('acked critical stops escalating', countOf(t18, 'stop_breach') === 0);
}

/**
 * 10. Indicator detectors. Nothing else in the suite supplies bars, so without this the
 *     three indicator detectors are only verified by the compiler.
 *
 *     The entry series is CALIBRATED by search rather than hand-tuned: the condition is a
 *     composite over two SMA-seeded EMAs and a Wilder RSI, and a hand-picked slope that
 *     silently stops satisfying it would turn this into an assertion that always passes.
 */
function findEntrySeries(p: Policy): number[] | null {
  const decline = Array.from({ length: 50 }, (_, i) => 130 - 0.5 * i);
  for (const slope of [1, 2, 3, 4, 6]) {
    for (let k = 1; k <= 40; k++) {
      const closes = [...decline];
      for (let j = 1; j <= k; j++) closes.push(decline[decline.length - 1] + slope * j);
      const fast = ema(closes, p.strategy.emaFast);
      const slow = ema(closes, p.strategy.emaSlow);
      const r = rsi(closes, p.strategy.rsiPeriod);
      const lastRsi = r.length > 0 ? r[r.length - 1] : null;
      if (crossedAbove(fast, slow) && lastRsi !== null && lastRsi >= p.strategy.rsiEntryMin) {
        return closes;
      }
    }
  }
  return null;
}

function indicators(): void {
  const p = getPolicy();
  const downtrend = Array.from({ length: 60 }, (_, i) => 130 - 0.5 * i); // 130 -> 100.5
  const entryCloses = findEntrySeries(p);

  if (entryCloses === null) {
    check('entry series calibration converged', false, 'no slope/length satisfied the composite');
    return;
  }
  check('entry series calibration converged', true);

  const world: World = {
    positions: [position('AAPL', 10, 101)],
    prices: { AAPL: 100.5, MSFT: entryCloses[entryCloses.length - 1] },
    bars: { AAPL: series(downtrend, at(0)), MSFT: series(entryCloses, at(0)) },
  };

  const t0 = tick(world, at(0), p);
  checkCount(t0, 'rsi_exit_zone', 1);
  checkCount(t0, 'ema_cross_down', 1);
  checkCount(t0, 'entry_signal', 1);

  // Same bars next tick: every one of these is latched, so a second fire would mean the
  // indicator detectors are re-deriving edges the bus already owns.
  const t1 = tick(world, at(1), p);
  checkCount(t1, 'rsi_exit_zone', 0);
  checkCount(t1, 'ema_cross_down', 0);
  checkCount(t1, 'entry_signal', 0);
}

/**
 * 11. ET date and the daily reset.
 *
 *     The baseline the daily-loss limit is measured against used to be re-keyed from inside
 *     `toolGetAccount`, off the UTC date — so it re-baselined a session that was still in
 *     progress (UTC rolls over mid after-hours ET) and only when the model happened to call
 *     a tool. Both halves are asserted on the pure, injectable seams: `etDate(now)` takes
 *     its clock as a parameter, and `ensureDailyReset` must short-circuit before collecting,
 *     which is the only reason it is safe to call with no broker behind it.
 */
async function etAndDailyReset(): Promise<void> {
  const evening = new Date('2026-03-02T02:00:00.000Z'); // 21:00 ET on Mar 1
  check(
    `21:00 ET belongs to the previous trading date`,
    etDate(evening) === '2026-03-01',
    `got ${etDate(evening)}`,
  );
  check(
    'the UTC slice would have disagreed',
    evening.toISOString().slice(0, 10) !== etDate(evening),
    `both said ${etDate(evening)}`,
  );

  const midday = new Date('2026-03-02T15:00:00.000Z'); // 10:00 ET
  check('10:00 ET keeps the same date', etDate(midday) === '2026-03-02', `got ${etDate(midday)}`);

  check('reset is a no-op once the day is baselined', (await ensureDailyReset()) === false);
  check('baseline untouched', getState().startOfDayEquity === ACCOUNT.equity);
}

/**
 * 12. Closed session. `maxQuoteAgeMs` is a market-hours rule; applied around the clock it
 *     made every overnight a stale-data storm — one `warn` per position plus one per
 *     watchlist symbol, for a market that was simply shut.
 *
 *     Asserts BOTH halves, because the gate's failure modes point in opposite directions:
 *     price staleness must go quiet overnight, and account staleness must NOT — the broker
 *     answers 24/7, so equity we cannot read at 03:00 is real connectivity loss.
 */
function closedSession(): void {
  const hold = [position('AAPL', 10, 100)];

  // Same dead-feed world as scenario 4, ten hours later on the clock.
  const dead = tick({ positions: hold, prices: { AAPL: null, MSFT: null } }, atNight(0));
  checkCount(dead, 'data_stale', 0);
  check('no stop_breach against a closed market', countOf(dead, 'stop_breach') === 0);

  const down = tick(
    { positions: hold, prices: { AAPL: null }, accountDown: true },
    atNight(1),
  );
  const stale = down.filter((e) => e.kind === 'data_stale');
  check('account staleness still reports overnight', stale.length === 1, `got ${stale.length}`);
  check('and it is the account one, not a price one', stale[0]?.symbol === null, `got ${stale[0]?.symbol}`);
}

/**
 * 13. Overnight heartbeat. Holding a position used to mean `urgent` at a 15-minute cadence
 *     around the clock — 96 full LLM cycles a day, none of them actionable, because nothing
 *     can move the position while the market is shut. Overnight it must be context, not an
 *     alarm: `info`, and paced by the slow cadence.
 */
function overnightHeartbeat(): void {
  const hold = [position('AAPL', 10, 100)];

  const t0 = tick({ positions: hold, prices: { AAPL: 100 } }, atNight(0));
  const beat = t0.find((e) => e.kind === 'heartbeat');
  check('heartbeat still fires while closed', beat !== undefined);
  check('but as info, so it wakes nobody', beat?.severity === 'info', `got ${beat?.severity}`);
  check('and it records the session it saw', beat?.evidence.session === 'closed', `got ${beat?.evidence.session}`);

  // 20 minutes on: past heartbeatWithPositionsMs (15m), well short of heartbeatFlatMs (60m).
  const t20 = tick({ positions: hold, prices: { AAPL: 100 } }, atNight(20));
  checkCount(t20, 'heartbeat', 0);

  const t70 = tick({ positions: hold, prices: { AAPL: 100 } }, atNight(70));
  checkCount(t70, 'heartbeat', 1);

  // The supersession rule: two info beats on one key must leave ONE pending event, or a
  // night's worth of them all render into the next cycle's context block.
  const beats = getPendingEvents().filter((e) => e.kind === 'heartbeat');
  check('successive info beats supersede rather than pile up', beats.length === 1, `got ${beats.length}`);
}

/**
 * Counting stubs in place of the trader and the concierge. The router's whole contract is
 * HOW MANY TIMES it calls them, so the doubles record calls rather than doing anything.
 */
function routerSpy() {
  const wakes: number[] = [];
  const alerts: string[] = [];
  const route = createLiveRouter({
    wakeTrader: () => void wakes.push(Date.now()),
    alertUser: (message) => void alerts.push(message),
  });
  return { wakes, alerts, route };
}

/**
 * 14. Live routing. The pipeline is only worth building if it reaches the decision maker,
 *     and only survivable if it reaches it ONCE per tick. A busy tick produces several
 *     waking events and several alerting ones — `entry_signal` alone fires per watchlist
 *     symbol — and delivering those one at a time is what turns a working detector into a
 *     wake storm. `pushAlert` costs two turns of concierge history per call, so the
 *     alerting side has to coalesce as well, not just the waking side.
 */
function liveRouting(): void {
  const busy = {
    positions: [position('AAPL', 10, 100), position('MSFT', 10, 100)],
    prices: { AAPL: 95, MSFT: 106 },
  };

  const { snapshot, fired } = tickBoth(busy, at(0));

  // The world is asserted before the router, so a detector change that silently drains the
  // input cannot make the coalescing checks pass by delivering nothing.
  check('breach fires critical', countOf(fired, 'stop_breach') === 1);
  check('surge fires warn', countOf(fired, 'position_surge') === 1);
  const waking = fired.filter((e) => e.severity === 'urgent' || e.severity === 'critical');
  const alerting = fired.filter((e) => e.severity === 'warn' || e.severity === 'critical');
  check('several events want the trader', waking.length >= 2, `got ${waking.length}`);
  check('several events want the operator', alerting.length >= 2, `got ${alerting.length}`);

  const spy = routerSpy();
  spy.route(fired);

  check('one wake for the whole tick', spy.wakes.length === 1, `got ${spy.wakes.length}`);
  check('one alert for the whole tick', spy.alerts.length === 1, `got ${spy.alerts.length}`);
  check(
    'and the alert carries the critical headline',
    spy.alerts[0]?.includes('stop breach') === true,
    spy.alerts[0] ?? '(none)',
  );
  check(
    'the warn travels in the same message',
    spy.alerts[0]?.includes('MSFT') === true,
    spy.alerts[0] ?? '(none)',
  );

  // Overnight, seventeen hours on: the same held position, nothing crossing, so the only
  // thing left is the `info` heartbeat. `info` is context — it must reach the next cycle's
  // context block and NOBODY's sleep, or step 3's whole point is undone one layer up.
  const quiet = tickBoth({ positions: [position('AAPL', 10, 100)], prices: { AAPL: 100 } }, atNight(0));
  check('only the info heartbeat is left', quiet.fired.length === 1, `got ${quiet.fired.length}`);
  check('and it is info', quiet.fired[0]?.severity === 'info', `got ${quiet.fired[0]?.severity}`);

  const night = routerSpy();
  night.route(quiet.fired);
  check('info wakes nobody', night.wakes.length === 0, `got ${night.wakes.length}`);
  check('info alerts nobody', night.alerts.length === 0, `got ${night.alerts.length}`);
}

/**
 * 15. Escalation text. `wakeCount` is the one number that distinguishes "the machine has
 *     noticed" from "the machine has noticed three times and nobody has done anything" —
 *     and the third report of an unacked critical is worded identically to the first unless
 *     the router says so. Scenario 9 proves the counter climbs; this proves it is spoken.
 */
function escalationText(): void {
  const world = { positions: [position('AAPL', 10, 100)], prices: { AAPL: 95 } };

  tick(world, at(0));   // wakeCount 1
  tick(world, at(6));   // 2 — past criticalCooldownMs, still unacked
  const third = tickBoth(world, at(12));

  const breach = third.fired.find((e) => e.kind === 'stop_breach');
  check('third report reaches wakeCount 3', breach?.wakeCount === 3, `got ${breach?.wakeCount}`);

  const spy = routerSpy();
  spy.route(third.fired);

  check('the alert says it is unactioned', spy.alerts[0]?.includes('UNACTIONED') === true, spy.alerts[0] ?? '(none)');
  check('and says how many times', spy.alerts[0]?.includes('x3') === true, spy.alerts[0] ?? '(none)');

  // The first report must NOT carry the escalation wording, or "unactioned" becomes noise
  // that says nothing about whether anyone is handling it.
  resetEventRegistry();
  const first = tickBoth(world, at(30));
  const plainSpy = routerSpy();
  plainSpy.route(first.fired);
  check(
    'a first report is worded plainly',
    plainSpy.alerts[0]?.includes('UNACTIONED') === false,
    plainSpy.alerts[0] ?? '(none)',
  );
}

/**
 * 16. The journal seam. `recordDecision` is reached from the entry, exit, veto and ack
 *     paths, so the harness WILL write decisions the moment a scenario drives a tool.
 *     This asserts the one thing that makes that safe: `useEphemeralJournal()` suppresses
 *     the append while `recordDecision` still returns a fully stamped record, so the
 *     caller's `entryDecisionId` round-trip is exercised rather than skipped.
 */
function journalSeam(): void {
  const before = readDecisions().length;
  const sizeBefore = fs.existsSync(JOURNAL_FILE) ? fs.statSync(JOURNAL_FILE).size : -1;

  const rec = recordDecision({
    kind: 'entry', actor: 'trader', symbol: 'REPLAY',
    triggerEventId: null, rationale: 'replay harness — must never reach disk',
    executed: true, qty: 1, price: 1, intendedStop: 0.9, intendedTarget: 1.2,
    atrAtEntry: 0.05, orderId: null, vetoRule: null, venueMessage: null, pnl: null,
    policyVersion: getPolicy().version,
  });

  check('the record is still stamped', rec.id.startsWith('entry:REPLAY:') && rec.at !== '', rec.id);
  check('id and at agree', rec.id.endsWith(rec.at), rec.id);

  const sizeAfter = fs.existsSync(JOURNAL_FILE) ? fs.statSync(JOURNAL_FILE).size : -1;
  check('nothing was appended to disk', sizeAfter === sizeBefore, `${sizeBefore} -> ${sizeAfter}`);
  check('and nothing is readable back', readDecisions().length === before, `${before} -> ${readDecisions().length}`);
  check(
    'no REPLAY symbol in the real journal',
    readDecisions({ symbol: 'REPLAY' }).length === 0,
  );
}

/**
 * The rule a malformed intent was refused by, or a description of what happened instead.
 * Returning a string rather than throwing keeps every case one `check` line, and makes a
 * regression read as `expected invalid_intent, got daily_loss_breached` instead of as a
 * scenario that threw.
 */
async function guardRule(signal: SignalResult, qty: number): Promise<string> {
  try {
    await enterPosition(signal, qty);
    return 'no rejection — the order reached the broker';
  } catch (err: any) {
    return err instanceof GuardRejection ? err.rule : `${err.name}: ${err.message}`;
  }
}

/**
 * 17. The guard, called directly — the only tier that can prove the two new rules, since
 *     both are refusals the detectors never see and the LLM is the only other caller.
 *
 *     Every case here is refused BEFORE `enterPosition` reaches the broker, which is what
 *     lets this run with no venue and no fake one. That is a property of the guard's
 *     ordering rather than a convenience: the free local checks come first so a `NaN` qty
 *     is reported as a malformed intent and not as insufficient buying power for
 *     `NaN × NaN`. The scenario's `startOfDayEquity` seed is the interlock for the day that
 *     stops being true — an absurd baseline breaches the daily loss limit against any real
 *     account, so a regression that drops a local check dead-ends two rules later with the
 *     wrong rule name and still never places an order.
 */
async function guardRules(): Promise<void> {
  const good: SignalResult = {
    symbol: 'AAPL', signal: 'buy', reason: 'replay — guard rules',
    price: 100, atr: 1.5, stopLoss: 98, takeProfit: 104,
  };

  const malformed: Array<[string, SignalResult, number]> = [
    ['qty of zero',            good, 0],
    ['negative qty',           good, -5],
    ['NaN qty',                good, NaN],
    ['NaN price',              { ...good, price: NaN }, 10],
    ['missing atr',            { ...good, atr: NaN }, 10],
    ['takeProfit below entry', { ...good, takeProfit: 99 }, 10],
  ];
  for (const [label, signal, qty] of malformed) {
    const rule = await guardRule(signal, qty);
    check(`invalid_intent — ${label}`, rule === 'invalid_intent', `got ${rule}`);
  }

  // `policy.immutable.requireStopOnEntry` has been true since the policy file existed and
  // was enforced nowhere; each of these opened a position with no exit level.
  const unstopped: Array<[string, number]> = [
    ['a stop of zero',        0],
    ['a negative stop',      -1],
    ['a stop above entry',  101],
    ['a stop at entry',     100],
  ];
  for (const [label, stopLoss] of unstopped) {
    const rule = await guardRule({ ...good, stopLoss }, 10);
    check(`missing_stop — ${label}`, rule === 'missing_stop', `got ${rule}`);
  }

  // A veto is a decision, and the journal is where decisions go. Asserted on the returned
  // record rather than by reading the file back — scenario 16 owns the disk suppression —
  // so what this pins is the shape `npm run journal` will demand of a real veto line:
  // a rule, no execution.
  let veto: DecisionRecord | null = null;
  try {
    await enterPosition({ ...good, stopLoss: 0 }, 10);
  } catch (err: any) {
    veto = recordDecision(decision('veto', 'guard', {
      symbol: good.symbol, rationale: good.reason, vetoRule: err.rule,
    }));
  }
  check('the veto is recorded with its rule and not as executed',
    veto !== null
      && veto.kind === 'veto'
      && veto.actor === 'guard'
      && veto.symbol === 'AAPL'
      && veto.vetoRule === 'missing_stop'
      && veto.executed === false,
    JSON.stringify(veto));
}

/**
 * 18. The watchlist scan reports the tick that produced it, and says so when there is none.
 *
 *     `get_watchlist_scan` is not a measurement — it is a second reading of numbers the tick
 *     already computed. So the only thing worth asserting is that it does not become a
 *     different truth about the same tick: score for score, symbol for symbol, against the
 *     `TickData` handed to `recordTick`. Everything else here is a way a table can lie by
 *     omission, and each one has to be visible in the output rather than absent from it:
 *     no tick at all, a symbol the machine declined to score, a symbol with no price but
 *     usable bars, a held symbol, and a table the scheduler has stopped refreshing.
 */
function watchlistScanProjection(): void {
  const p = getPolicy();
  const interval = p.triggers.tickIntervalMs;

  // Before the first tick. An empty `rows` would read as "no candidates", which is a
  // different claim and a false one.
  const cold = watchlistScan(getLastTick(), interval, at(0).getTime());
  check('before any tick the scan is an explicit error, not an empty watchlist',
    cold.error !== undefined && cold.tickAt === null && cold.rows.length === 0 && cold.ageMs === null,
    JSON.stringify(cold));

  const uptrend = Array.from({ length: 60 }, (_, i) => 100 + 0.4 * i);   // scoreable
  const short = Array.from({ length: 10 }, (_, i) => 50 + 0.2 * i);      // below minBars
  const world: World = {
    positions: [position('AAPL', 10, 101)],
    prices: {
      AAPL: 101,                    // held — excluded upstream by compute.ts
      MSFT: uptrend[uptrend.length - 1],
      NVDA: 51,                     // too little history to score
      COIN: null,                   // feed failed; bars are still usable
    },
    bars: {
      AAPL: series(uptrend, at(0)),
      MSFT: series(uptrend, at(0)),
      NVDA: series(short, at(0)),
      COIN: series(uptrend, at(0)),
    },
  };

  const { snapshot } = tickBoth(world, at(0), p);
  recordTick(snapshot);
  const scan = watchlistScan(getLastTick(), interval, at(0).getTime());

  check('the scan is stamped with the tick that produced it',
    scan.error === undefined && scan.tickAt === snapshot.tickAt && scan.ageMs === 0,
    JSON.stringify({ tickAt: scan.tickAt, expected: snapshot.tickAt, ageMs: scan.ageMs }));

  // Symbol for symbol against the source, in both directions: a row the tick did not
  // produce is as wrong as a row it produced and the scan dropped.
  const scanned = scan.rows.map((r) => r.symbol).sort();
  const expected = Object.keys(snapshot.watchlist).sort();
  check('every watchlist symbol of that tick is a row, and nothing else is',
    JSON.stringify(scanned) === JSON.stringify(expected),
    `scan ${JSON.stringify(scanned)} vs tick ${JSON.stringify(expected)}`);

  // Score for score. Rounding to 3dp is the only transformation the projection is allowed.
  const msft = scan.rows.find((r) => r.symbol === 'MSFT');
  const srcMsft = snapshot.watchlist.MSFT;
  const scoresMatch =
    msft !== undefined
    && msft.signals.length === srcMsft.signals.length
    && msft.signals.length > 0
    && msft.signals.every((s, i) =>
      s.name === srcMsft.signals[i].name && near(s.score, srcMsft.signals[i].score, 5e-4));
  check('the scores are the tick\'s scores, not a recomputation',
    scoresMatch,
    JSON.stringify({ scan: msft?.signals, tick: srcMsft.signals }));

  check('the tally is derived from those same scores by signalTally',
    msft !== undefined
      && msft.tally.total === srcMsft.signals.length
      && msft.tally.bullish === srcMsft.signals.filter((s) => s.score > 0.1).length,
    JSON.stringify(msft?.tally));

  // A row the machine declined to score STAYS, with the reason. Dropped, it would be
  // indistinguishable from a symbol that is not on the watchlist.
  const nvda = scan.rows.find((r) => r.symbol === 'NVDA');
  check('too little history is a row with a reason, not a missing row',
    nvda !== undefined && nvda.signals.length === 0 && nvda.notScored !== null,
    JSON.stringify(nvda));
  check('and the caveats name it',
    scan.caveats.some((c) => c.includes('NVDA') && c.includes('Not scored')),
    JSON.stringify(scan.caveats));

  // The whole reason `stale` is renamed on the way out: the price is gone, the signals
  // are not, and one flag beside five scores would be read as covering both.
  const coin = scan.rows.find((r) => r.symbol === 'COIN');
  check('a dead price feed leaves the bar-derived scores standing, and priceStale says which is which',
    coin !== undefined
      && coin.price === null
      && coin.priceStale
      && coin.priceStaleReason !== null
      && coin.signals.length > 0,
    JSON.stringify({ price: coin?.price, priceStale: coin?.priceStale, signals: coin?.signals.length }));

  // Held names are skipped by compute.ts, so their absence has to be stated or it reads
  // as "not on the watchlist".
  check('a held symbol is named as excluded rather than silently missing',
    scan.heldExcluded.includes('AAPL')
      && !scanned.includes('AAPL')
      && scan.caveats.some((c) => c.includes('AAPL') && c.includes('held')),
    JSON.stringify({ heldExcluded: scan.heldExcluded, caveats: scan.caveats }));

  check('rows are ordered by bullish count, descending',
    scan.rows.every((r, i) => i === 0 || scan.rows[i - 1].tally.bullish >= r.tally.bullish),
    JSON.stringify(scan.rows.map((r) => [r.symbol, r.tally.bullish])));

  // A table the scheduler has stopped refreshing still reports its numbers — refusing
  // would be a second opinion on staleness, which belongs to observe(). It says its age.
  const stale = watchlistScan(getLastTick(), interval, at(0).getTime() + interval * 4);
  check('a table older than a few tick intervals reports its age as a caveat, and still reports its rows',
    stale.rows.length === scan.rows.length
      && stale.ageMs === interval * 4
      && stale.caveats.some((c) => c.includes('old')),
    JSON.stringify({ ageMs: stale.ageMs, caveats: stale.caveats }));

  // The seam `scenario()` relies on. Without it a tick leaks into the next scenario.
  resetLastTick();
  check('resetLastTick clears the store, so no tick leaks between scenarios',
    getLastTick() === null && watchlistScan(getLastTick(), interval).error !== undefined);
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Loaded once, before any state is faked — a failure here is a broken policy file,
  // not a failed scenario.
  const policy = getPolicy();
  console.log(`Replay — policy v${policy.version}, ${DETECTORS.length} detectors\n`);

  const stopped = (stop: number, high?: number): Partial<SystemState> => ({
    positionSnapshots: {
      AAPL: snapshotSeed('AAPL', { entryPrice: 100, stopLevel: stop, sessionHigh: high }, OPENED),
    },
  });
  const plain: Partial<SystemState> = {
    positionSnapshots: { AAPL: snapshotSeed('AAPL', { entryPrice: 100 }, OPENED) },
  };

  await scenario('1. Slow bleed — one event per crossing, not per tick', stopped(90), slowBleed);
  await scenario('2. Flutter — hysteresis absorbs boundary noise', plain, flutter);
  await scenario('3. Recover then re-breach — cooldown outlives re-arming', plain, recoverThenRebreach);
  await scenario('4. Stale feed — silence is reported, not assumed', stopped(99), staleFeed);
  await scenario('5. New session high — drawdown measures from the high', plain, newSessionHigh);
  await scenario('6. Restart — arming survives, acks do not', plain, restart);
  await scenario('7. Policy edit — same market, different events', plain, policyEdit);
  await scenario('8. Immutable violation — a bad edit changes nothing', plain, immutableViolation);
  await scenario('9. Escalation — an unanswered critical gets louder', stopped(99), escalation);
  await scenario('10. Indicator detectors — bars in, edges out', {
    positionSnapshots: {
      AAPL: snapshotSeed('AAPL', { entryPrice: 101, sessionHigh: 101 }, OPENED),
    },
  }, indicators);
  await scenario('11. ET date — the day turns at 00:00 ET, not 00:00 UTC', {
    lastResetDate: etDate(),
  }, etAndDailyReset);
  await scenario('12. Closed session — a shut market is not a dead feed', stopped(99), closedSession);
  await scenario('13. Overnight heartbeat — context, not an alarm', plain, overnightHeartbeat);
  await scenario('14. Live routing — many events, one wake, one alert', {
    positionSnapshots: {
      AAPL: snapshotSeed('AAPL', { entryPrice: 100, stopLevel: 99 }, OPENED),
      MSFT: snapshotSeed('MSFT', { entryPrice: 100 }, OPENED),
    },
  }, liveRouting);
  await scenario('15. Escalation text — an unactioned critical says so', stopped(99), escalationText);
  await scenario('16. Journal seam — a replay decision never reaches the real journal', plain, journalSeam);
  // The absurd baseline is the interlock, not a fixture: see `guardRules`.
  await scenario('17. Guard rules — a malformed or unstopped intent never reaches the venue', {
    startOfDayEquity: 1e12,
  }, guardRules);
  await scenario('18. Watchlist scan — the table is the tick, and absent is not empty', {
    positionSnapshots: { AAPL: snapshotSeed('AAPL', { entryPrice: 101 }, OPENED) },
  }, watchlistScanProjection);

  console.log(`\n${'─'.repeat(72)}`);
  if (failures.length === 0) {
    console.log(`REPLAY PASS — ${passed} checks`);
    return;
  }
  console.log(`REPLAY FAIL — ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}

void main();
