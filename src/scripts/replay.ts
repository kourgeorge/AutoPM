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
import type { AccountInfo, OpenOrder, Position } from '../broker/IBroker';
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
import { REVERSAL_LOOKBACK, reversalFilter } from '../strategy/reversal';
import { computeSignals, signalTally } from '../strategy/signals';
import { dailyLossStatus } from '../strategy/riskManager';
import { GuardRejection, enterPosition, entrySignalVeto, positionSizeVeto, restingSells } from '../strategy/orderManager';
import { canTighten, needsArming, stopOrderFor, unheldSnapshots } from '../strategy/stopOrders';
import { isCryptoSymbol } from '../core/symbols';
import {
  getState,
  resetDailyState,
  updateState,
  useEphemeralState,
  type PositionSnapshot,
  type SystemState,
} from '../state/state';
import { publishPortfolioReview } from '../review/scheduledReview';

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

/**
 * The confirming reading gate 0 requires, thrown away.
 *
 * `triggers.confirmTicks` means a price-derived level fires on its SECOND breached reading,
 * so a scenario that shows the world once and expects an event is asserting the old spec.
 * This presents the same world one tick earlier and discards the result: by construction it
 * fires none of the confirmed events, and the one thing it can fire — the crossing-less
 * heartbeat — is asserted by nothing that calls this.
 *
 * Scenarios that are ABOUT the gate spell the two readings out instead of calling this.
 */
function warm(world: World, when: Date, policy: Policy = getPolicy()): void {
  tick(world, new Date(when.getTime() - MIN), policy);
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

  // Bounded rather than exact: k=6 is -2.376% (the crossing), k=7 is -2.767% (the reading
  // that CONFIRMS it), k=8 is -3.155%. Requiring the fired value to sit in (-3.0, -2.5]
  // pins it to k=7 without hard-coding a float. Firing at k=6 means gate 0 is not counting;
  // firing after k=7 means an edge was missed.
  const drop = all.find((e) => e.kind === 'position_drop');
  const firedAtPct = drop?.evidence.pnlPct as number | undefined;
  check(
    'position_drop fires on the reading that confirms the crossing',
    firedAtPct !== undefined && firedAtPct <= -2.5 && firedAtPct > -3.0,
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

  // Two readings per breach: gate 0 confirms on the second, so every fire needs a pair.
  all.push(...tick({ positions: hold, prices: { AAPL: 97.9 } }, at(0)));   // -2.1%, confirming
  all.push(...tick({ positions: hold, prices: { AAPL: 97.9 } }, at(1)));   // fire
  all.push(...tick({ positions: hold, prices: { AAPL: 98.6 } }, at(2)));   // -1.4% -> re-arm
  const inCooldown = [
    ...tick({ positions: hold, prices: { AAPL: 97.9 } }, at(3)),
    // Armed AND confirmed, and still quiet — which is the whole point of the scenario.
    ...tick({ positions: hold, prices: { AAPL: 97.9 } }, at(4)),
  ];
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
  const t5 = tick({ positions: hold, prices: { AAPL: 95 } }, at(4));

  const down = [...t2, ...t3];
  check('no stop_breach while the feed is dead', countOf(down, 'stop_breach') === 0);
  checkCount(down, 'data_stale', 1);
  // The FIRST reading off a recovered feed is the one gate 0 exists to distrust: a feed that
  // just came back is exactly where a bad quote comes from.
  check(
    'the first reading off a recovered feed does not fire on its own',
    countOf(t4, 'stop_breach') === 0,
    `got ${countOf(t4, 'stop_breach')}`,
  );
  check(
    'stop_breach fires as soon as the recovered feed confirms it',
    countOf(t5, 'stop_breach') === 1,
    `got ${countOf(t5, 'stop_breach')}`,
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

  tick({ positions: hold, prices: { AAPL: 107.5 } }, at(1));
  const t3 = tick({ positions: hold, prices: { AAPL: 107.5 } }, at(2));
  const dd = t3.find((e) => e.kind === 'trailing_drawdown');
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
  warm({ positions: hold, prices: { AAPL: 97.5 } }, at(0));
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

  warm({ positions: hold, prices: { AAPL: 97.5 } }, at(0), live);
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

  warm({ positions: hold, prices: { AAPL: 97.5 } }, at(0), edited.policy);
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

  warm(world, at(0));
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
      // All three arming conditions, because the detector now arms on all three. Searching on
      // only the cross and the RSI would find a series that fires nothing, and scenario 10 would
      // report a missing `entry_signal` as a bus fault rather than as a calibration miss.
      const composite = signalTally(computeSignals(series(closes, at(0)), p)).composite;
      if (
        crossedAbove(fast, slow)
        && lastRsi !== null
        && lastRsi >= p.strategy.rsiEntryMin
        && composite !== null
        && composite >= p.strategy.compositeMin
      ) {
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

  warm(busy, at(0));
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
  // A count would be the wrong assertion here: the price coming back to 100 also clears
  // every level it breached above, so the quiet tick carries the beat AND the all-clears.
  // What matters is that none of it is addressed to anyone.
  check('nothing waking or alerting is left', quiet.fired.length > 0
    && quiet.fired.every((e) => e.severity === 'info'),
    quiet.fired.map((e) => `${e.kind}/${e.severity}`).join(', ') || '(none)');
  check('the beat is still among them', countOf(quiet.fired, 'heartbeat') === 1);

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

  warm(world, at(0));
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
  warm(world, at(30));
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
    atrAtEntry: 0.05, orderId: null, vetoRule: null, venueMessage: null,
    venueStopId: null, venueStopMissing: null, pnl: null,
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
 * 24. The daily loss halt with no baseline — the alarm and the brake at zero.
 *
 *     Two things watch this limit: the detector (the alarm, on the tick loop) and
 *     `enterPosition` (the brake, on the order path). Both used to go blind at exactly the
 *     same moment, in opposite ways, and nothing here noticed because every other scenario
 *     seeds a positive baseline.
 *
 *       - `buildAccountData` yielded `dayPnLPct: null` when the baseline was <= 0, and the
 *         detector answered null with `return []`. Silence, indistinguishable from a flat day.
 *       - `enterPosition` substituted `getState().startOfDayEquity || account.equity`, so the
 *         change was measured against today's own equity: exactly 0.00%, and the one guard
 *         that halts a losing day could not trip.
 *
 *     So on a cold start — `DEFAULT_STATE.startOfDayEquity` is 0 and the daemon starts the
 *     scheduler and the trader un-awaited — the alarm was off and the brake was off together.
 *
 *     The brake is asserted through `dailyLossStatus` rather than `enterPosition`, for the
 *     same reason `entrySignalVeto` is: the daily-loss guard sits
 *     AFTER `broker.getAccountInfo()`, and this harness has no venue (see scenario 17). The
 *     guard is now nothing but `state === 'unmeasurable' -> reject`, so the judgement is the
 *     whole of it. `ensureDailyReset`'s refusal to persist a non-positive baseline is the one
 *     part of the fix no tier here can reach — it needs a broker to return the bad number.
 */
function dailyLossWithoutBaseline(): void {
  const limit = getPolicy().risk.maxDailyLossPct;   // fraction, e.g. 0.03

  // ── The predicate both sides now share ────────────────────────────────────────
  const flat = dailyLossStatus(100_000, 100_000, limit);
  check('a flat day is measurable and not breached',
    flat.state === 'ok' && near(flat.dayPnLPct, 0), JSON.stringify(flat));

  // Percentage points on both sides of the comparison. Getting this wrong by a factor of 100
  // is the failure mode that reads as "the limit is 0.03% and every day breaches it".
  check('the threshold is percentage points, not a fraction',
    near(flat.thresholdPct, -limit * 100), JSON.stringify(flat));

  const past = dailyLossStatus(100_000 * (1 - limit) - 1, 100_000, limit);
  check('a loss past the limit is breached',
    past.state === 'breached', JSON.stringify(past));
  const shy = dailyLossStatus(100_000 * (1 - limit / 2), 100_000, limit);
  check('a loss short of the limit is not breached',
    shy.state === 'ok', JSON.stringify(shy));

  // ── No baseline is not a flat day ─────────────────────────────────────────────
  const zero = dailyLossStatus(100_000, 0, limit);
  check('a zero baseline is unmeasurable, not 0.00%',
    zero.state === 'unmeasurable' && zero.dayPnLPct === null, JSON.stringify(zero));
  check('and it says which number is missing',
    zero.reason !== null && zero.reason.includes('start-of-day equity'), zero.reason ?? 'none');

  // The sharp one. `0` is falsy so the old `|| account.equity` caught it, but a NEGATIVE
  // baseline passed through, and dividing by a negative flips the sign: a 20% loss read as a
  // +20% gain, so the brake saw a winning day on the worst day an account can have.
  const negative = dailyLossStatus(80_000, -100_000, limit);
  check('a negative baseline is unmeasurable rather than sign-flipped',
    negative.state === 'unmeasurable', JSON.stringify(negative));
  check('and it is certainly not reported as a gain',
    negative.dayPnLPct === null || negative.dayPnLPct < 0, JSON.stringify(negative));

  const noEquity = dailyLossStatus(null, 100_000, limit);
  check('an unreadable account is unmeasurable too',
    noEquity.state === 'unmeasurable' && noEquity.reason === 'no usable equity reading',
    JSON.stringify(noEquity));

  // ── The alarm ─────────────────────────────────────────────────────────────────
  //
  // Seeded with the cold-start baseline of 0 (see the registry entry). A live account, a live
  // price: nothing here is stale, so the only reason the detector cannot answer is the baseline.
  const world = { positions: [position('AAPL', 10, 100)], prices: { AAPL: 100 } };
  const fired = tick(world, at(1));

  const spoke = fired.filter((e) => e.kind === 'daily_loss_breach');
  check('the detector reports that it cannot measure instead of falling silent',
    spoke.length === 1, `got ${spoke.length} daily_loss_breach event(s)`);
  check('the headline says so in words the operator can act on',
    spoke.length === 1 && spoke[0].headline.includes('cannot be measured'),
    spoke[0]?.headline ?? 'none');

  // `warn` reaches the operator without waking a cycle: the brake has already refused every
  // entry, so there is nothing for the trader to decide. A `critical` here would wake the LLM
  // to be told the brake is on, and an `info` would be filtered out of the rendered list and
  // reach nobody at all.
  check('it alerts the operator without waking the trader',
    spoke.length === 1 && spoke[0].severity === 'warn', spoke[0]?.severity ?? 'none');

  // Crossing-less, so `processHits` treats it as a cooldown-gated one-shot. It must not
  // re-announce on the very next tick, and — the reason the old heartbeat bug mattered — it
  // must not be latched into silence forever either.
  const again = tick(world, at(2));
  check('it does not repeat on the next tick',
    countOf(again, 'daily_loss_breach') === 0, `got ${countOf(again, 'daily_loss_breach')}`);
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

  // ── Position size ─────────────────────────────────────────────────────────────
  //
  // Asserted on `positionSizeVeto` for the same reason as the entry gate below: the scenario's
  // absurd equity baseline refuses every intent as `daily_loss_breached` two guards earlier, and
  // the judgement is pure anyway.
  //
  // This is the number POLICY.md asked the model to apply to itself while nothing checked, and the
  // one that had no guard at all — `maxPositions x positionSizePct` is 100% of equity by default, so
  // the untested case was the whole book in one name.
  const sizePol = getPolicy();
  const sizeEquity = 100_000;
  const sizeBudget = sizeEquity * sizePol.risk.positionSizePct;
  const fits = Math.floor(sizeBudget / 100);

  check('the qty the formula produces is not refused',
    positionSizeVeto(fits, 100, sizeEquity, sizePol) === null,
    JSON.stringify({ fits, budget: sizeBudget }));
  check('one share more than the budget, inside the drift allowance, is still not refused',
    positionSizeVeto(fits + 1, 100, sizeEquity, sizePol) === null,
    `budget $${sizeBudget}, asked $${(fits + 1) * 100}`);

  // The case with no guard before this: a request that clears buying power on margin and is still
  // many times the position budget.
  const tenX = positionSizeVeto(fits * 10, 100, sizeEquity, sizePol);
  check('ten times the budget is refused', tenX !== null, 'not refused');
  // The message has to carry the qty that WOULD fit. A refusal that says only "too big" leaves the
  // model guessing, and a guess it retries is another refused cycle.
  check('the message names the budget and the qty that fits',
    tenX !== null && tenX.includes(sizeBudget.toFixed(2)) && tenX.includes(`${fits} or fewer`),
    tenX ?? 'none');
  // Named clean, never inflated: the allowance is slack for equity drift, not a size the model may
  // ask for on purpose.
  check('the qty it names is the policy number, not the tolerance-inflated one',
    tenX !== null && !tenX.includes(`${Math.floor(sizeBudget * 1.02 / 100)} or fewer`),
    tenX ?? 'none');

  // Scales with the account rather than with a constant, and a fractional unit is not exempt.
  check('a smaller account gets a smaller budget for the same price',
    positionSizeVeto(fits, 100, sizeEquity / 10, sizePol) !== null,
    'a tenth of the equity accepted the full-size qty');
  check('a fractional qty is measured by its notional like any other',
    positionSizeVeto(0.5, sizeBudget * 4, sizeEquity, sizePol) !== null,
    'half a unit at twice the budget was accepted');

  // ── The entry gate ────────────────────────────────────────────────────────────
  //
  // Asserted on `entrySignalVeto` rather than through `enterPosition`, and that is the
  // reason the function is exported at all: the live path fetches bars from a feed this
  // harness does not have, and the scenario's absurd equity baseline would refuse every
  // intent as `daily_loss_breached` two guards earlier. What matters is the decision, and
  // the decision is pure.
  //
  // POLICY.md asked the model to apply this threshold to itself for as long as it existed
  // and nothing checked. These are the checks.
  const pol = getPolicy();
  const gateMin = pol.strategy.compositeMin;

  const asBars = (closes: number[], opts: { stale?: boolean } = {}): Maybe<Bar[]> => ({
    value: series(closes, at(0)),
    source: 'alpaca',
    asOf: at(0).toISOString(),
    fetchedAt: at(0).toISOString(),
    stale: opts.stale ?? false,
  });

  // A run of 60 rising closes: every trend signal reads the same tape and agrees.
  const strong = Array.from({ length: 60 }, (_, i) => 100 + 0.4 * i);
  const strongComposite = signalTally(computeSignals(series(strong, at(0)), pol)).composite;
  check('the fixtures bracket the gate — a clean uptrend clears it',
    strongComposite !== null && strongComposite >= gateMin,
    JSON.stringify({ composite: strongComposite, gateMin }));
  check('a setup above the threshold is not refused',
    entrySignalVeto('MSFT', asBars(strong), pol, gateMin) === null,
    JSON.stringify(entrySignalVeto('MSFT', asBars(strong), pol, gateMin)));

  // The same tape falling. This is the case that used to reach the venue: nothing between
  // the prompt's sentence and `broker.placeOrder` looked at the composite at all.
  const weak = Array.from({ length: 60 }, (_, i) => 124 - 0.4 * i);
  const weakComposite = signalTally(computeSignals(series(weak, at(0)), pol)).composite;
  check('the fixtures bracket the gate — a downtrend fails it',
    weakComposite !== null && weakComposite < gateMin,
    JSON.stringify({ composite: weakComposite, gateMin }));
  const weakVeto = entrySignalVeto('MSFT', asBars(weak), pol, gateMin);
  check('low_composite — a downtrend is refused before the venue',
    weakVeto?.rule === 'low_composite', JSON.stringify(weakVeto));
  // The refusal has to carry both numbers. A guard that says only "too weak" leaves the
  // model with no way to tell a near miss from a rejection it should stop retrying.
  check('the low_composite message quotes the score and the threshold it missed',
    weakVeto !== null
      && weakVeto.message.includes(weakComposite!.toFixed(2))
      && weakVeto.message.includes(gateMin.toFixed(2)),
    weakVeto?.message ?? 'none');

  // The threshold is an ARGUMENT, which is what lets a regime raise it. Same tape, same
  // moment, stricter gate — the detector resolves this number the same way, so the two
  // layers cannot hold different thresholds for one instant.
  check('a regime that raises the gate refuses what the base gate allowed',
    entrySignalVeto('MSFT', asBars(strong), pol, 1.0)?.rule === 'low_composite',
    JSON.stringify(entrySignalVeto('MSFT', asBars(strong), pol, 1.0)));

  // Fail closed, under a SEPARATE rule name. Weak setups and a broken bar feed are both
  // refusals, but only one of them is about the market, and a journal that files them
  // together can no longer answer which it was.
  const unscoreable: Array<[string, Maybe<Bar[]>]> = [
    ['no bars at all', missing('alpaca', 'feed down')],
    ['bars present but stale', asBars(strong, { stale: true })],
    ['fewer bars than minBars', asBars(strong.slice(0, pol.strategy.minBars - 1))],
  ];
  for (const [label, bars] of unscoreable) {
    const v = entrySignalVeto('MSFT', bars, pol, gateMin);
    check(`signals_unavailable — ${label}`, v?.rule === 'signals_unavailable', JSON.stringify(v));
  }

  // The point of the split, stated as an assertion: a stale copy of a tape that would
  // otherwise PASS is refused, and not under the name that means "too weak".
  const staleStrong = entrySignalVeto('MSFT', asBars(strong, { stale: true }), pol, gateMin);
  check('stale bars that would have passed are refused as unavailable, never as low_composite',
    staleStrong !== null && staleStrong.rule !== 'low_composite', JSON.stringify(staleStrong));
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

  // The number POLICY.md thresholds on, checked against the tick's own scores rather than
  // against a constant: a hard-coded +0.42 would keep passing while the mean was being taken
  // over the wrong array.
  const meanOfSrc = srcMsft.signals.reduce((sum, s) => sum + s.score, 0) / srcMsft.signals.length;
  check('the composite is the mean of those same scores, not a second reading of the bars',
    msft !== undefined && near(msft.tally.composite, meanOfSrc, 5e-4),
    JSON.stringify({ composite: msft?.tally.composite, mean: meanOfSrc }));

  // Reversal travels with the row but stays out of the five. A "consistency" fix that folded it
  // into `signals` would average a monthly contrarian reading into a same-day trend one, and the
  // filter would stop being a filter.
  check('reversal is not a sixth signal: the scored array is still the five trend measures',
    msft !== undefined
      && msft.signals.length === 5
      && !msft.signals.some((s) => /reversal/i.test(s.name)),
    JSON.stringify(msft?.signals.map((s) => s.name)));

  // The tick reads market caps from cache only and the harness injects none, so `unknown` here
  // is the contract working. An unknown cap must never be quietly treated as a large one.
  check('every scored row carries a reversal reading, and a missing market cap says so',
    msft !== undefined
      && msft.reversal.oneMonthReturnPct !== null
      && msft.reversal.sizeBucket === 'unknown'
      && msft.reversal.marketCap === null,
    JSON.stringify(msft?.reversal));

  check('and the caveats say the size adjustment did not happen, and where to get it',
    scan.caveats.some((c) => c.includes('MSFT') && c.includes('get_fundamentals')),
    JSON.stringify(scan.caveats));

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

  // Ordered by the continuous reading, not by the vote count: three signals barely past the
  // dead band outrank two strong ones on a count, and at a screen height that shows six of
  // eighteen rows that keeps the wrong six.
  check('rows are ordered by composite, descending',
    scan.rows.every((r, i) =>
      i === 0
      || (scan.rows[i - 1].tally.composite ?? -Infinity) >= (r.tally.composite ?? -Infinity)),
    JSON.stringify(scan.rows.map((r) => [r.symbol, r.tally.composite])));

  // Unscored sorts last rather than as neutral: no evidence is not the middle of the range.
  check('an unscored row reports composite null, not 0, and sorts last',
    nvda !== undefined
      && nvda.tally.composite === null
      && scan.rows[scan.rows.length - 1].symbol === 'NVDA',
    JSON.stringify(scan.rows.map((r) => [r.symbol, r.tally.composite])));

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

/**
 * P6 — the book, once per close.
 *
 * The only thing worth asserting about a once-a-day event is the count, in both directions:
 * that it happens, and that nothing makes it happen twice. Everything else here exists to
 * stop a future "fix" from quietly breaking one of those.
 *
 * Sector fields are deliberately NOT asserted. `getCachedSectors` reads `data/sectors.json`,
 * so `bySector` depends on what the operator's cache happens to hold; the weights, the HHI and
 * the firing do not. Asserting a sector here would make the suite pass or fail on a file
 * nothing in the harness controls.
 */
function portfolioReviewLoop(): void {
  const p = getPolicy();

  // AAPL is stopped, MSFT is not — one of each, because "which positions are unwatched" is the
  // one reading in this event that is a fact rather than a judgement.
  const world: World = {
    positions: [position('AAPL', 10, 101), position('MSFT', 100, 120)],
    prices: { AAPL: 101, MSFT: 130 },
    bars: {},
  };
  const monday = at(0);                 // 2026-03-02, 10:00 ET
  const tuesday = at(1440);
  const friday = at(4 * 1440);          // 2026-03-06

  // `computeTick` without `publishTick`: the detectors would write their own cooldowns, and
  // then "cooldowns untouched" below could only be a comparison rather than an absolute.
  const snapshot = computeTick(bundle(world, monday), p);
  check('the tick under review holds both positions and prices them',
    Object.keys(snapshot.positions).sort().join(',') === 'AAPL,MSFT'
      && snapshot.positions.MSFT.price === 130,
    JSON.stringify(Object.keys(snapshot.positions)));

  // 1. First run ANNOUNCES. It does not adopt — the deliberate departure from reviewReady,
  //    which adopts only because a fills ledger has a backlog and a book does not.
  const first = publishPortfolioReview(snapshot, p, monday);
  check('a book never reviewed before announces on the first close, it does not adopt silently',
    first.length === 1 && first[0].kind === 'portfolio_review',
    JSON.stringify(first.map((e) => e.kind)));
  checkCount(first, 'portfolio_review', 1);

  const ev = first[0];
  check('it is a warn that suggests reflection — the session is over, so it wakes nobody',
    ev.severity === 'warn' && ev.suggestedAction === 'reflect' && ev.symbol === null,
    JSON.stringify({ severity: ev.severity, action: ev.suggestedAction, symbol: ev.symbol }));

  // 2. Numbers are the tick's, recomputed here from the seed rather than read back from the
  //    event. AAPL 10 x 101 = 1010, MSFT 100 x 130 = 13000, on 100k of equity.
  const e = ev.evidence as Record<string, any>;
  check('the evidence measures the book that produced it',
    e.positionCount === 2
      && near(e.grossDeployedPct, 14.0, 0.05)
      && e.maxWeightSymbol === 'MSFT'
      && near(e.maxWeightPct, 13.0, 0.05)
      && near(e.hhi, 0.866, 0.005),
    JSON.stringify({ n: e.positionCount, gross: e.grossDeployedPct, max: e.maxWeightSymbol, w: e.maxWeightPct, hhi: e.hhi }));

  check('a position with no stop recorded is named, and a stopped one is not',
    Array.isArray(e.positionsWithoutStop)
      && e.positionsWithoutStop.length === 1
      && e.positionsWithoutStop[0] === 'MSFT',
    JSON.stringify(e.positionsWithoutStop));

  check('Monday is a daily review',
    e.scope === 'daily' && ev.headline.startsWith('Daily portfolio review'), ev.headline);

  check('what is missing names the tool that has it, rather than being left blank',
    typeof e.omittedNote === 'string'
      && e.omittedNote.includes('get_exposure')
      && e.omittedNote.includes('get_scorecard'),
    String(e.omittedNote));

  // 3. Same close, called again. This is the whole point of the watermark: `maybeReconcile`
  //    runs on a 5-minute cadence and a restart re-enters this path.
  check('the same session close is never announced twice',
    publishPortfolioReview(snapshot, p, monday).length === 0
      && publishPortfolioReview(snapshot, p, new Date(monday.getTime() + 90 * MIN)).length === 0);

  // 4. `publishDiscrete` bypasses the cooldown machinery on purpose — a cooldown key per close
  //    would grow state.json forever, and there is no level here to recross.
  check('no cooldown is written, so a daily event cannot leak into state.json forever',
    Object.keys(getState().eventCooldowns).length === 0,
    JSON.stringify(getState().eventCooldowns));

  // 5. The next trading day is a new close.
  const second = publishPortfolioReview(snapshot, p, tuesday);
  checkCount(second, 'portfolio_review', 1);
  check('the watermark advanced to the close it announced',
    etDate(new Date(getState().lastPortfolioReviewAt)) === etDate(tuesday),
    getState().lastPortfolioReviewAt);

  // 6. Friday's close carries the week. One watermark, so this is a label on the same event —
  //    a Friday the process misses is a weekly review skipped, not a queued one.
  const weekly = publishPortfolioReview(snapshot, p, friday);
  check('the week\'s last close is labelled weekly',
    weekly.length === 1
      && (weekly[0].evidence as any).scope === 'weekly'
      && weekly[0].headline.startsWith('Weekly portfolio review'),
    weekly.map((w) => w.headline).join(''));

  // 7. The daily reset must not clear it. It is a watermark on the exchange's calendar, not
  //    part of the day it describes.
  const held = getState().lastPortfolioReviewAt;
  resetDailyState(123_456, etDate(friday));
  check('the daily reset leaves the review watermark alone',
    getState().lastPortfolioReviewAt === held, getState().lastPortfolioReviewAt);

  // 8. A corrupted watermark fails OPEN. Failing closed would mean a review that is silent at
  //    every close forever, which is the one outcome this event cannot survive.
  updateState({ lastPortfolioReviewAt: 'not-a-date' });
  check('an unreadable watermark is treated as never reviewed, not as already reviewed',
    publishPortfolioReview(snapshot, p, monday).length === 1,
    getState().lastPortfolioReviewAt);

  // 9. A flat book still fires. "You have been flat all week" is exactly what this is for, and
  //    silence there would look identical to the process being down.
  updateState({ lastPortfolioReviewAt: '' });
  const empty = computeTick(bundle({ positions: [], prices: {}, bars: {} }, monday), p);
  const flat = publishPortfolioReview(empty, p, monday);
  check('a flat book is reviewed too, and says so',
    flat.length === 1
      && (flat[0].evidence as any).positionCount === 0
      && flat[0].headline.includes('flat')
      && (flat[0].evidence as any).concentrationCaveats.includes('no open positions'),
    JSON.stringify({ headline: flat[0]?.headline, caveats: (flat[0]?.evidence as any)?.concentrationCaveats }));
}

// ── Run ───────────────────────────────────────────────────────────────────────

/**
 * 20. Confirmation and the all-clear — the two states the bus used to have no words for.
 *
 *     Part A is the emptied-book bug in miniature. After the close an IEX book loses one
 *     side and reports it as `0`, so the mid is HALF the real price: below any stop, and
 *     stamped seconds after the closing print so it passes every freshness check. One
 *     reading is not a condition, and a level that appears for a single tick and then
 *     returns must leave nothing behind — no event, and no cooldown either, or the next
 *     genuine breach arrives to find itself already in a quiet period it never earned.
 *
 *     Part B is the opposite omission. Recrossing the band re-armed the key SILENTLY, so
 *     the operator and the model were told a stop was breached and then never told it
 *     wasn't. The all-clear is `info` on purpose — a recovery must not wake anyone — which
 *     is precisely why it needs asserting: an event that routes to nobody is invisible
 *     until you count it.
 */
function confirmAndResolve(): void {
  const hold = [position('AAPL', 10, 100)];
  const level = (world: { positions: Position[]; prices: Record<string, number | null> }, k: number) =>
    tick(world, at(k));

  // ── Part A: one bad reading, swallowed ──────────────────────────────────────
  const spike = [
    ...level({ positions: hold, prices: { AAPL: 100 } }, 0),
    // 50.00 — the halved mid. Under the 99 stop, -50% from entry, 50% off the session high:
    // it breaches all three price levels at once, which is what makes it worth swallowing.
    ...level({ positions: hold, prices: { AAPL: 50 } }, 1),
    ...level({ positions: hold, prices: { AAPL: 100 } }, 2),
  ];

  checkCount(spike, 'stop_breach', 0);
  checkCount(spike, 'position_drop', 0);
  checkCount(spike, 'trailing_drawdown', 0);
  check(
    'a swallowed breach announces no all-clear either',
    countOf(spike, 'condition_resolved') === 0,
    `got ${countOf(spike, 'condition_resolved')}`,
  );

  // The trace assertion. If an unconfirmed breach wrote a cooldown, the real breach in part
  // B would be gated by a quiet period started by a quote that never should have counted.
  const cooldowns = getState().eventCooldowns;
  check(
    'and it leaves no cooldown behind',
    ['stop_breach:AAPL', 'position_drop:AAPL', 'trailing_drawdown:AAPL']
      .every((key) => !(key in cooldowns)),
    JSON.stringify(cooldowns),
  );

  // ── Part B: a real breach, then the recovery ────────────────────────────────
  const confirming = level({ positions: hold, prices: { AAPL: 95 } }, 10);
  const firing = level({ positions: hold, prices: { AAPL: 95 } }, 11);
  const recovery = level({ positions: hold, prices: { AAPL: 100 } }, 12);

  check(
    'the first reading of a real breach is still only a reading',
    countOf(confirming, 'stop_breach') === 0,
    `got ${countOf(confirming, 'stop_breach')}`,
  );
  check('the second one fires', countOf(firing, 'stop_breach') === 1);

  // Every kind that fired must clear, and clear exactly once — the same recross that
  // re-arms the key is the only chance it gets to say so.
  // Everything except the crossing-less beat: a heartbeat has no threshold, so there is
  // nothing for it to come back past and nothing to clear.
  const raised = new Set(firing.map((e) => e.kind).filter((k) => k !== 'heartbeat'));
  const cleared = recovery.filter((e) => e.kind === 'condition_resolved');
  const clearedKinds = cleared.map((e) => e.evidence.resolvedKind as string);
  check(
    'every reported condition clears when the price comes back',
    raised.size > 0 && [...raised].every((k) => clearedKinds.includes(k)),
    `raised ${[...raised].join(', ')} / cleared ${clearedKinds.join(', ')}`,
  );
  check(
    'and none of them clears twice',
    cleared.length === clearedKinds.length && new Set(clearedKinds).size === clearedKinds.length,
    clearedKinds.join(', '),
  );
  check(
    'the all-clear names the condition it is about',
    cleared.some((e) => e.headline.includes('stop_breach cleared')),
    cleared.map((e) => e.headline).join(' | ') || '(none)',
  );

  // A recovery is not news that interrupts anyone. Asserted through the real router rather
  // than by reading the severity, because the severity is only meaningful via the routing.
  check('an all-clear is info', cleared.every((e) => e.severity === 'info'));
  const spy = routerSpy();
  spy.route(cleared);
  check('so it wakes nobody', spy.wakes.length === 0, `got ${spy.wakes.length}`);
  check('and alerts nobody', spy.alerts.length === 0, `got ${spy.alerts.length}`);

  // Still recovered on the next tick: the all-clear is an edge, not a state, so a second
  // quiet reading must say nothing at all.
  const stillFine = level({ positions: hold, prices: { AAPL: 100 } }, 13);
  checkCount(stillFine, 'condition_resolved', 0);
}

/**
 * 21. Blocking orders — what stands between a decision to exit and the venue.
 *
 *     Alpaca does not count the shares you own, it counts the shares nothing else has a
 *     claim on. A resting sell reserves them, so a market sell alongside one is refused with
 *     `403 insufficient qty available (available: 0)` — which is a rejection the model can
 *     do nothing with, because it has no cancellation tool. Measured live on CRM
 *     2026-08-28: 25 held, 25 reserved by a hand-placed GTC stop, every exit impossible.
 *
 *     Only the selection is asserted here. Cancelling needs a venue, and this harness has
 *     none by design — but WHICH orders are in the way is the part that can be wrong
 *     silently, and a miss means the exit still walks into the wall.
 */
function blockingOrders(): void {
  const order = (o: Partial<OpenOrder>): OpenOrder => ({
    id: 'o1', symbol: 'AAPL', side: 'sell', qty: 10, filled: 0,
    type: 'stop', rawType: 'stop', status: 'new', ...o,
  });

  const book: OpenOrder[] = [
    order({ id: 'stop',      type: 'stop',  rawType: 'stop',  stopPrice: 95 }),
    order({ id: 'target',    type: 'limit', rawType: 'limit', limitPrice: 120 }),
    order({ id: 'partial',   qty: 10, filled: 4, stopPrice: 94 }),
    order({ id: 'buy',       side: 'buy' }),
    order({ id: 'other-sym', symbol: 'MSFT' }),
  ];

  const blocking = restingSells(book, 'AAPL').map((o) => o.id).sort();
  check(
    'every open sell on the symbol is in the way, whatever its type',
    JSON.stringify(blocking) === JSON.stringify(['partial', 'stop', 'target']),
    blocking.join(', '),
  );
  check(
    'a buy reserves buying power, not shares, so it is not in the way',
    !blocking.includes('buy'),
  );
  check(
    "and another symbol's sell is not in the way",
    !blocking.includes('other-sym'),
  );

  // The crypto naming split, which is what made `already_holding` and `no_position` wrong
  // before `sameSymbol` existed. A blocking order the venue calls BTCUSD must be found by a
  // caller asking about BTC/USD, or the exit is refused by the venue with no explanation
  // this system can offer.
  const crypto = restingSells([order({ id: 'btc', symbol: 'BTCUSD' })], 'BTC/USD');
  check('a blocking order is found across the crypto naming split', crypto.length === 1);

  check('an empty book blocks nothing', restingSells([], 'AAPL').length === 0);
}

/**
 * 22. Venue stops — which positions are naked, and which stop may replace which.
 *
 *     The recorded stop and the resting order are two different things, and every bug this
 *     scenario guards is a place where they get confused for each other. Arming a second stop
 *     over shares another order already reserves is refused by the venue on every tick forever;
 *     failing to arm at all leaves a position with nothing behind it overnight; and loosening a
 *     stop is the mechanism by which a small loss becomes a large one.
 *
 *     Only the pure selections are asserted. `broker` is a module-level const with no injection
 *     seam — the same reason scenario 17 stops at the guards — but WHICH positions need a stop
 *     and WHETHER a level may move are the parts that fail silently.
 */
function venueStops(): void {
  const pos = (p: Partial<Position>): Position => ({
    symbol: 'AAPL', qty: 10, avgCost: 100, marketValue: 1100, ...p,
  });
  const order = (o: Partial<OpenOrder>): OpenOrder => ({
    id: 'o1', symbol: 'AAPL', side: 'sell', qty: 10, filled: 0,
    type: 'stop', rawType: 'stop', status: 'new', ...o,
  });

  // ── stopOrderFor: what may be sent, and what may not
  const equity = stopOrderFor('AAPL', 10, 95);
  check(
    'an equity with a level and shares gets a well-formed GTC-able sell stop',
    equity.ok && equity.request.type === 'stop' && equity.request.side === 'sell'
      && equity.request.qty === 10 && equity.request.stopPrice === 95,
    JSON.stringify(equity),
  );

  // Both spellings, because the venue reports one and the caller holds the other. The slash
  // test alone passes the first and fails the second, which is the bug this exists to prevent.
  for (const sym of ['BTC/USD', 'BTCUSD']) {
    const c = stopOrderFor(sym, 0.5, 40000);
    check(
      `no stop can rest for ${sym}, and the refusal says why`,
      !c.ok && /crypto/i.test(c.reason),
      c.ok ? 'placed anyway' : c.reason,
    );
  }
  check('BRK-B is not mistaken for a pair', isCryptoSymbol('BRK-B') === false);

  const short = stopOrderFor('AAPL', -10, 95);
  check(
    'a short is skipped rather than guessed at — a sell stop would double it',
    !short.ok && /short/i.test(short.reason),
    short.ok ? 'placed anyway' : short.reason,
  );
  check('no level recorded means no order', !stopOrderFor('AAPL', 10, 0).ok);

  // ── needsArming: the join across positions, orders and snapshots
  const snaps: Record<string, PositionSnapshot> = {
    AAPL:   snapshotSeed('AAPL',   { entryPrice: 100, stopLevel: 95 }, OPENED),
    MSFT:   snapshotSeed('MSFT',   { entryPrice: 120, stopLevel: 110 }, OPENED),
    TSLA:   snapshotSeed('TSLA',   { entryPrice: 200 }, OPENED),          // no level on purpose
    BTCUSD: snapshotSeed('BTC/USD', { entryPrice: 40000, stopLevel: 38000 }, OPENED),
    XLE:    snapshotSeed('XLE',    { entryPrice: 80, stopLevel: 75 }, OPENED),
    GE:     snapshotSeed('GE',     { entryPrice: 50, stopLevel: 60 }, OPENED),
  };
  const book = [
    pos({ symbol: 'AAPL', qty: 10, marketValue: 1000 }),                  // naked → arm
    pos({ symbol: 'MSFT', qty: 5,  marketValue: 600 }),                   // already stopped
    pos({ symbol: 'TSLA', qty: 3,  marketValue: 600 }),                   // no level recorded
    pos({ symbol: 'BTCUSD', qty: 0.5, marketValue: 20000 }),              // venue takes no stop
    pos({ symbol: 'XLE',  qty: 100, marketValue: 8000 }),                 // half reserved by a TP
    pos({ symbol: 'GE',   qty: 20, marketValue: 1100 }),                  // level already through
  ];
  const orders = [
    order({ id: 'msft-stop', symbol: 'MSFT', qty: 5, stopPrice: 110 }),
    order({ id: 'xle-tp', symbol: 'XLE', qty: 60, type: 'limit', rawType: 'limit', limitPrice: 90 }),
    order({ id: 'aapl-buy', side: 'buy', qty: 5, type: 'market', rawType: 'market' }),
  ];

  const arm = needsArming(book, orders, snaps);
  const names = arm.map(a => a.symbol).sort();
  check(
    'only the positions with a level and nothing enforcing it are selected',
    JSON.stringify(names) === JSON.stringify(['AAPL', 'XLE']),
    names.join(', ') || '(none)',
  );
  check(
    'a stop already resting is found across the naming the venue uses, so nothing double-arms',
    !names.includes('MSFT'),
  );
  check(
    'a level already through the market is left to the breach detector, not fired instantly',
    !names.includes('GE'),
  );
  check(
    'a buy on the same symbol reserves no shares and does not reduce what can be stopped',
    arm.find(a => a.symbol === 'AAPL')?.qty === 10,
    String(arm.find(a => a.symbol === 'AAPL')?.qty),
  );
  // The alternative — asking for all 100 — is refused by the venue every tick, forever.
  check(
    'a take-profit over part of the position leaves the rest stoppable, and only the rest',
    arm.find(a => a.symbol === 'XLE')?.qty === 40,
    String(arm.find(a => a.symbol === 'XLE')?.qty),
  );
  check('the level armed is the level recorded', arm.find(a => a.symbol === 'AAPL')?.stopLevel === 95);
  check('nothing held means nothing to arm', needsArming([], orders, snaps).length === 0);

  // ── unheldSnapshots: which records have no position behind them
  check(
    'a book that covers every snapshot leaves nothing to prune',
    unheldSnapshots(book, snaps).length === 0,
    unheldSnapshots(book, snaps).join(','),
  );
  check(
    'a snapshot with no position behind it is the one thing reported',
    JSON.stringify(unheldSnapshots(book, { ...snaps, NFLX: snapshotSeed('NFLX', { entryPrice: 76 }, OPENED) })) === '["NFLX"]',
    unheldSnapshots(book, { ...snaps, NFLX: snapshotSeed('NFLX', { entryPrice: 76 }, OPENED) }).join(','),
  );
  // The venue reports `BTCUSD` and the snapshot was written from `BTC/USD`. A raw-string set
  // here would prune a live crypto position's recorded level — the one it cannot re-arm.
  check(
    'a pair held under the other spelling is still held',
    !unheldSnapshots(book, snaps).includes('BTCUSD'),
  );
  // A short is held. `needsArming` refuses to arm a sell stop over it, which is a different
  // question from whether its recorded level may be deleted.
  check(
    'a short position keeps its snapshot',
    unheldSnapshots([pos({ symbol: 'AAPL', qty: -10 })], { AAPL: snaps.AAPL }).length === 0,
  );

  // ── canTighten: the one predicate the tool and the sweep share
  check('raising a stop is allowed', canTighten(95, 97));
  check('lowering a stop is refused', !canTighten(95, 93));
  check('restating the same stop is not loosening, so a retry is not a violation', canTighten(95, 95));
  check('nothing recorded yet means nothing to loosen', canTighten(undefined, 95));
  check('a nonsense level is refused whatever is recorded', !canTighten(95, 0));
}

/**
 * Reversal — the sign convention, and the size interaction that needs a market cap.
 *
 * Two things are worth asserting here and the rest is arithmetic nobody will break. First the
 * SIGN: this score reads the opposite way to the five signal scores, so a future "consistency"
 * fix that flipped it would silently turn "don't chase" into "do", with nothing else in the
 * suite noticing. Second the SIZE leg: the same month is chasing in a small cap and not in a
 * mega cap, which is the only reason a market cap is threaded through `computeTick` at all — so
 * the injected cap has to arrive at the row, and a missing one has to stay visible instead of
 * defaulting to a permissive bucket.
 *
 * The fixtures are built so the move over the window is an exact percentage: with 60 bars the
 * window runs from index 38 to index 59, so holding everything up to 38 flat at 100 makes the
 * return the ramp's end value minus 100, and the expected scores can be written down rather
 * than copied out of a previous run.
 */
function reversalEntryFilter(): void {
  const p = getPolicy();

  /** 60 closes, flat at 100 until the reversal window opens, then a straight ramp to +pct. */
  const ranBy = (pct: number): number[] => {
    const closes = Array.from({ length: 60 }, () => 100);
    for (let i = 39; i < 60; i++) closes[i] = 100 * (1 + (pct / 100) * ((i - 38) / 21));
    return closes;
  };

  const MEGA = 3e12;
  const SMALL = 1e9;
  const up12 = series(ranBy(12), at(0));

  // ── The sign, first, because everything else reads off it.
  const chased = reversalFilter(up12, MEGA);
  check('a name that ran scores NEGATIVE — the opposite way to a signal score',
    near(chased.oneMonthReturnPct, 12, 5e-3) && chased.score < 0,
    JSON.stringify(chased));

  const pulled = reversalFilter(series(ranBy(-10), at(0)), MEGA);
  check('a name that pulled back scores positive',
    near(pulled.oneMonthReturnPct, -10, 5e-3) && pulled.score > 0,
    JSON.stringify(pulled));

  // ── The interaction: one move, two verdicts, and the only difference is the cap.
  const asSmall = reversalFilter(up12, SMALL);
  check('the same +12% month is chasing in a small cap and not in a mega cap',
    asSmall.chasing && !chased.chasing
      && asSmall.chaseThresholdPct === 8 && chased.chaseThresholdPct === 15,
    JSON.stringify({ small: asSmall, mega: chased }));

  check('and it is scored harder there, because the threshold it cleared is lower',
    asSmall.score < chased.score && near(asSmall.score, -0.75, 5e-3) && near(chased.score, -0.4, 5e-3),
    JSON.stringify({ small: asSmall.score, mega: chased.score }));

  // The threshold is where chasing STARTS, so -1 must sit at twice it, not at it.
  const doubled = reversalFilter(series(ranBy(30), at(0)), MEGA);
  check('the score saturates at twice the threshold, not at the threshold',
    near(chased.score, -0.4, 5e-3) && near(doubled.score, -1, 5e-3),
    JSON.stringify({ atThreshold: chased.score, atDouble: doubled.score }));

  // ── An unknown cap is a stated gap, never a bucket.
  const noCap = reversalFilter(up12);
  check('no market cap means bucket unknown, a middle threshold, and a detail line that says so',
    noCap.sizeBucket === 'unknown'
      && noCap.marketCap === null
      && noCap.chaseThresholdPct === 12
      && noCap.detail.includes('market cap unknown'),
    JSON.stringify(noCap));
  check('and it is not the most permissive case: the mega bucket still tolerates more',
    noCap.chaseThresholdPct < chased.chaseThresholdPct,
    JSON.stringify({ unknown: noCap.chaseThresholdPct, mega: chased.chaseThresholdPct }));

  // ── Too little history is a null reading, not a zero move.
  const short = reversalFilter(series(ranBy(12).slice(-REVERSAL_LOOKBACK), at(0)), MEGA);
  check('a window that does not fit reports null, scores 0 and never claims chasing',
    short.oneMonthReturnPct === null && short.score === 0 && !short.chasing
      && short.detail.includes('insufficient'),
    JSON.stringify(short));

  // ── And the cap has to survive the trip through the real tick.
  const world: World = {
    positions: [],
    prices: { MSFT: 112, NVDA: 112 },
    bars: { MSFT: up12, NVDA: up12 },
  };
  const snapshot = computeTick(bundle(world, at(0)), p, { MSFT: MEGA, NVDA: SMALL });
  const megaRow = snapshot.watchlist.MSFT.reversal;
  const smallRow = snapshot.watchlist.NVDA.reversal;
  check('computeTick hands each symbol its own market cap, and identical bars still disagree',
    megaRow.sizeBucket === 'mega' && smallRow.sizeBucket === 'small'
      && !megaRow.chasing && smallRow.chasing,
    JSON.stringify({ MSFT: megaRow, NVDA: smallRow }));

  // Injecting nothing is a supported call, not a degraded one — that is what the 60s loop does
  // for any symbol whose fundamentals have never been fetched.
  const uncapped = computeTick(bundle(world, at(0)), p);
  check('and a tick with no caps injected still produces the reading, marked unknown',
    uncapped.watchlist.MSFT.reversal.oneMonthReturnPct !== null
      && uncapped.watchlist.MSFT.reversal.sizeBucket === 'unknown',
    JSON.stringify(uncapped.watchlist.MSFT.reversal));

  // The filter must not leak into the thing it filters: the composite is still the mean of the
  // five, on a tape where reversal is firmly negative and would drag it if it were folded in.
  const scores = snapshot.watchlist.NVDA.signals;
  const mean = scores.length === 0 ? null : scores.reduce((sum, x) => sum + x.score, 0) / scores.length;
  check('the composite is the mean of the five and excludes the reversal score',
    mean !== null && near(signalTally(scores).composite, mean, 5e-4) && smallRow.score < 0,
    JSON.stringify({ composite: signalTally(scores).composite, mean, reversal: smallRow.score }));
}

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
  await scenario('19. Slow loop — the book, once per close, and never twice', {
    positionSnapshots: {
      AAPL: snapshotSeed('AAPL', { entryPrice: 101, stopLevel: 95 }, OPENED),
      MSFT: snapshotSeed('MSFT', { entryPrice: 120 }, OPENED),   // no stop on purpose
    },
  }, portfolioReviewLoop);
  await scenario('20. Confirmation and the all-clear — one reading is not a condition', stopped(99), confirmAndResolve);
  await scenario('21. Blocking orders — a resting sell reserves the shares an exit needs', plain, blockingOrders);
  await scenario('22. Venue stops — which positions are naked, and which stop may replace which', plain, venueStops);
  await scenario('23. Reversal — the reading that disagrees, and the cap that changes it', plain, reversalEntryFilter);
  // The zero baseline IS the fixture here, not an interlock: it is the cold-start state
  // (`DEFAULT_STATE.startOfDayEquity`) in which the alarm and the brake both used to go quiet.
  await scenario('24. Daily loss with no baseline — silence is not a flat day', {
    startOfDayEquity: 0,
  }, dailyLossWithoutBaseline);

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
