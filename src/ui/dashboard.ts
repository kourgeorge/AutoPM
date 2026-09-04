/**
 * The dashboard renderer: a model goes in, an array of blessed markup lines comes out.
 *
 * Pure and side-effect free, which is the whole point — it can be exercised at width 40 and
 * height 10 from a probe script with no terminal attached, and a bug in here is a wrong string
 * rather than a dead daemon.
 *
 * ## Why the data is typed structurally
 *
 * `TickSnapshot` below is a hand-written subset of `features/compute.ts`'s `TickData` rather
 * than an import of it. `compute.ts` pulls in `collect/` and therefore `core/config.ts`, which
 * THROWS at import time when `AI_API_KEY` is absent; and `ui/ui.ts` builds a blessed screen at
 * import time, so anything importing it inherits that. Keeping the UI's edge count near zero
 * is what lets both be probed. TypeScript's structural typing means `ui.setTick(realTickData)`
 * still type-checks: `TickData` has every field named here, plus more.
 *
 * The one deliberate exception is `strategy/signals` — a pure leaf (its only imports are a
 * type and `strategy/indicators`, which imports a type). It is imported instead of copied
 * because the dead band that decides whether a signal is "bullish" is a judgement, and a
 * second copy of `> 0.1` here would be a second truth about the same five numbers.
 *
 * ## Height and width are budgets, not assumptions
 *
 * Every renderer is told exactly how many columns and rows it may use and returns lines of
 * exactly that width. Rows are spent in a fixed priority order and a truncated list always
 * ends in `+N more`, so a short terminal hides rows but never hides that it hid them.
 */

import { signalTally, type SignalScore } from '../strategy/signals';
import { escapeTags as escapeCell, makeFormat, plainWidth, type Fmt } from './format';
import type { Glyphs } from './glyphs';

// ── The model ─────────────────────────────────────────────────────────────────

/** Structural subset of `compute.ts`'s `PositionData`. */
export interface PositionRow {
  symbol: string;
  qty: number;
  price: number | null;
  stale: boolean;
  entryPrice: number;
  pnlPct: number | null;
  stopLevel: number | null;
  distanceToStopPct: number | null;
  takeProfitLevel: number | null;
  distanceToTargetPct: number | null;
  rsi: number | null;
  heldForMs: number;
}

/** Structural subset of `compute.ts`'s `WatchlistData`. */
export interface WatchRow {
  symbol: string;
  price: number | null;
  stale: boolean;
  rsi: number | null;
  signals: SignalScore[];
  signalSummary: string;
}

/** Structural subset of `compute.ts`'s `TickData`. */
export interface TickSnapshot {
  positions: Record<string, PositionRow>;
  watchlist: Record<string, WatchRow>;
  account: {
    equity: number | null;
    buyingPower: number | null;
    cash: number | null;
    invested: number | null;
    dayPnLPct: number | null;
    positionCount: number;
  };
  session: string;
  tickAt: string;
  policyVersion: number;
}

/**
 * Structural subset of `eventBus.ts`'s `TriggerEvent` — same reasoning as `TickSnapshot` above:
 * this file must not import `eventBus.ts` (it pulls in `policy/types` and `state/state`), so the
 * shape is copied rather than imported, and `getPendingEvents()`'s real return value satisfies it
 * directly.
 */
export interface EventRow {
  id: string;
  kind: string;
  severity: 'info' | 'warn' | 'urgent' | 'critical';
  symbol: string | null;
  firedAt: string;
  headline: string;
  suggestedAction: string | null;
  ackedAt: string | null;
  ackDisposition: string | null;
  wakeCount: number;
}

/**
 * Structural subset of `core/proposals.ts`'s `Proposal` — same reasoning as `EventRow` above:
 * this file must stay import-free of `state/state.ts`, so the shape is copied, and
 * `getOpenProposals()`'s real return value satisfies it directly.
 */
export interface ProposalRow {
  id: string;
  kind: string;
  symbol: string;
  status: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
}

export type LaneState = 'starting' | 'idle' | 'thinking' | 'sleeping' | 'awaiting' | 'error';

/**
 * What one agent is doing. `until` is an absolute epoch ms, not a remaining duration, so the
 * 1s repaint can count it down without anyone re-sending it — that is what makes the panel
 * move between ticks at zero cost.
 */
export interface Lane {
  state: LaneState;
  until?: number;
  detail?: string;
}

export interface Environment {
  broker: string;
  /** `paper` or `live`. Rendered in red when live: a live book must never read as paper. */
  venue: string;
  provider: string;
  model: string;
  /**
   * The approval gate, as a badge — `gate: entry, exit` — or absent when disarmed.
   *
   * Optional and empty-when-off on purpose: `joinChunks` drops an empty chunk, so a disarmed
   * gate costs no columns, and a panel that says nothing about approvals is a panel where
   * nothing will ask. The armed case is the one that must be visible without being asked for,
   * because it changes what happens when the operator walks away.
   */
  gate?: string;
}

export interface Cycle {
  n: number;
  lastMs?: number;
  inTokens?: number;
  outTokens?: number;
}

export interface DashboardModel {
  env: Environment;
  tick: TickSnapshot | null;
  trader: Lane;
  concierge: Lane;
  cycle: Cycle;
  /** Epoch ms of this paint. Passed in, never read from the clock, so renders are pure. */
  now: number;
  /** Monotonic repaint counter; drives the spinner and the heartbeat blink. */
  frame: number;
  glyphs: Glyphs;
  /** Open events from the live registry — see `needsAttention`/`sortedEvents` below. */
  events: EventRow[];
  /** Tail of the durable event log, oldest-first — see `src/features/eventLog.ts`. */
  eventLog: EventRow[];
  /** Every proposal currently in the store — see `src/core/proposals.ts`'s `getAllProposals()`. */
  proposals: ProposalRow[];
}

// ── Small internal helpers ────────────────────────────────────────────────────

interface Chunk {
  text: string;
  color?: string;
}

interface Col extends Chunk {
  w: number;
  right?: boolean;
}

/**
 * Lay out fixed-width columns, dropping them right-to-left when the width runs out.
 *
 * This is the mechanism behind "robust at any size": a row is a priority-ordered list of
 * columns, and a narrow panel simply stops rendering the least important ones. Nothing is ever
 * squeezed into fewer columns than it needs, so numbers never lose digits silently.
 */
function packRow(f: Fmt, width: number, cols: Col[]): string {
  let used = 0;
  let out = '';
  for (const col of cols) {
    const gap = used === 0 ? 0 : 1;
    if (used + gap + col.w > width) {
      // The first column is identity — a blank row is worse than a truncated symbol.
      if (used === 0) {
        out += f.tint(escapeCell(f.fit(col.text, width)), col.color);
        used = width;
      }
      break;
    }
    if (gap) out += ' ';
    const text = col.right ? f.fitRight(col.text, col.w) : f.fit(col.text, col.w);
    out += f.tint(escapeCell(text), col.color);
    used += gap + col.w;
  }
  return out + ' '.repeat(Math.max(0, width - used));
}

/** Join chunks with a separator, dropping trailing chunks that do not fit. */
function joinChunks(f: Fmt, width: number, sep: string, chunks: Chunk[]): string {
  const sepW = plainWidth(sep);
  let used = 0;
  let out = '';
  for (const c of chunks) {
    if (!c.text) continue;
    const gap = used === 0 ? 0 : sepW;
    const w = plainWidth(c.text);
    if (used + gap + w > width) {
      if (used === 0) {
        out += f.tint(escapeCell(f.fit(c.text, width)), c.color);
        used = width;
      }
      break;
    }
    if (gap) out += `{gray-fg}${escapeCell(sep)}{/}`;
    out += f.tint(escapeCell(c.text), c.color);
    used += gap + w;
  }
  return out + ' '.repeat(Math.max(0, width - used));
}

function sessionColor(session: string): string {
  if (session === 'open') return 'green-fg';
  if (session === 'premarket' || session === 'afterhours') return 'yellow-fg';
  return 'gray-fg';
}

/** Compact token count: `840`, `18k`, `1.2M`. */
function tokens(n: number | undefined): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * A price with a sane number of digits at any magnitude: 2dp normally, none above 10,000 —
 * cents on a $118,000 coin are noise, and they are noise that would truncate the column.
 */
function priceText(f: Fmt, n: number | null): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return f.dash;
  return Math.abs(n) >= 10_000 ? f.money(n).replace('$', '') : n.toFixed(2);
}

/**
 * What a holding is worth, in whole dollars — `842`, `5,900`, `118,433`, `1.2M`.
 *
 * No cents, ever: this column answers "how big is this position", and at that question a dollar
 * is already below the noise. Compacted above a million so the cell can never need more columns
 * than it has, because a truncated `1,23…` reads as a smaller number rather than as a cut one.
 *
 * No `$` either, for the same reason `priceText` drops it: the columns beside this one are bare
 * numbers, and a currency mark repeated down a fixed grid is three columns spent saying nothing
 * that the `val` label above has not already said.
 */
function valueText(f: Fmt, n: number | null): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return f.dash;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  // `money` owns the thousands grouping and the sign placement; the cents it adds below $1,000
  // come straight back off, so one implementation still groups every number on the panel.
  return f.money(n).replace('$', '').replace(/\.\d\d$/, '');
}

/** What a lane is doing, as text plus colour. The countdown is computed from `until`. */
function laneChunk(m: DashboardModel, lane: Lane, spinner: boolean): Chunk {
  const f = makeFormat(m.glyphs);
  const spin = m.glyphs.spinner[m.frame % m.glyphs.spinner.length];

  switch (lane.state) {
    case 'thinking':
      return {
        text: `${spinner ? spin + ' ' : ''}${lane.detail ?? 'thinking'}`,
        color: 'cyan-fg',
      };
    case 'sleeping': {
      const left = lane.until != null ? f.duration(lane.until - m.now) : null;
      return { text: left ? `sleeping ${left}` : 'sleeping', color: 'white-fg' };
    }
    // The only lane state that is a REQUEST: the trader is stopped at the gate and will stay
    // there until the operator types y or n, or the countdown runs out and it is refused.
    // Yellow and bold, with the deadline counted down from `until` like `sleeping` — the
    // number an operator needs here is how long they have left, not how long they were given.
    case 'awaiting': {
      const left = lane.until != null ? f.duration(lane.until - m.now) : null;
      const what = lane.detail ?? 'approval';
      // No markup in `text`: `joinChunks` escapes it, so a `{bold}` here would print as one.
      return { text: `needs y/n: ${what}${left ? ` (${left})` : ''}`, color: 'yellow-fg' };
    }
    case 'error':
      return { text: lane.detail ?? 'error', color: 'red-fg' };
    case 'starting':
      return { text: lane.detail ?? 'starting', color: 'yellow-fg' };
    default:
      return { text: lane.detail ?? 'ready', color: 'gray-fg' };
  }
}

/**
 * Positions ordered by how close they are to their stop, nearest first.
 *
 * Deliberately not alphabetical: when the list is truncated, the rows that survive should be
 * the ones an operator would act on. A position with no recorded stop sorts last — it cannot
 * be near a level it does not have, and the missing stop is visible in its own column.
 */
function sortedPositions(tick: TickSnapshot): PositionRow[] {
  return Object.values(tick.positions).sort((a, b) => {
    const da = a.distanceToStopPct;
    const db = b.distanceToStopPct;
    if (da == null && db == null) return a.symbol.localeCompare(b.symbol);
    if (da == null) return 1;
    if (db == null) return -1;
    if (da !== db) return da - db;
    return a.symbol.localeCompare(b.symbol);
  });
}

/** One watchlist symbol with its signal lean already tallied. */
interface WatchEntry {
  row: WatchRow;
  bullish: number;
  bearish: number;
  total: number;
  /** Mean of the scores, null when unscored. What the `sig` column renders. */
  composite: number | null;
}

/**
 * Watchlist ordered by composite, so a truncated list keeps the interesting end.
 *
 * By the mean rather than the bullish count: the five signals all measure trend and agree most
 * of the time, so counting them put a symbol whose three positives were +0.15 level with one
 * whose three were +0.9, and at a height that shows six of eighteen rows that is the wrong six.
 * Unscored rows sort last rather than as zero — no reading is not a flat reading.
 */
function sortedWatchlist(tick: TickSnapshot): WatchEntry[] {
  return Object.values(tick.watchlist)
    .map((row) => {
      const t = signalTally(row.signals);
      return { row, bullish: t.bullish, bearish: t.bearish, total: t.total, composite: t.composite };
    })
    .sort(
      (a, b) =>
        (b.composite ?? -Infinity) - (a.composite ?? -Infinity) ||
        a.row.symbol.localeCompare(b.row.symbol),
    );
}

// ── Events ────────────────────────────────────────────────────────────────────

/**
 * An event a human should look at: severity warn or critical, and no ack recorded yet.
 *
 * Derived, not stored — `eventBus.ts` owns `severity` and `ackedAt`; this just reads both. Urgent
 * is deliberately excluded: it wakes the TRADER (`wakesTrader()` in `eventBus.ts`), not the
 * human, and counting it here would put a badge in front of the operator for something already
 * being handled.
 */
export function needsAttention(e: EventRow): boolean {
  return (e.severity === 'warn' || e.severity === 'critical') && e.ackedAt == null;
}

/**
 * Bucketed newest-first: unacked-critical, then unacked-warn, then everything else (acked, info,
 * and urgent-but-unacked — urgent is the trader's problem, not sorted to the top of a human's
 * list). Within a bucket, `firedAt` descending, so the panel reads like a feed.
 */
export function sortedEvents(events: EventRow[]): EventRow[] {
  const bucket = (e: EventRow): number => {
    if (e.severity === 'critical' && e.ackedAt == null) return 0;
    if (e.severity === 'warn' && e.ackedAt == null) return 1;
    return 2;
  };
  return [...events].sort((a, b) => {
    const ba = bucket(a);
    const bb = bucket(b);
    if (ba !== bb) return ba - bb;
    return Date.parse(b.firedAt) - Date.parse(a.firedAt);
  });
}

// ── Rows ──────────────────────────────────────────────────────────────────────

// ── The column grid ───────────────────────────────────────────────────────────

/**
 * Column widths for the two lists. The row renderer and the legend above it both read these,
 * because a legend positioned independently of its row is a legend that lies: the watchlist's
 * `px sig rsi` used to be right-aligned to the panel border while its four values sat on the
 * left, so the labels named columns of empty space.
 */
const POS_GRID = { sym: 5, px: 7, cost: 7, pnl: 7, stop: 6, tgt: 6, val: 8, qty: 5, rsi: 3, held: 6 } as const;
const WATCH_GRID = { sym: 5, px: 7, sig: 5, rsi: 3 } as const;

/**
 * Columns a complete position row needs: every field plus one space between each.
 *
 * Exported so `ui.ts` can cap the sidebar at the width of its widest row instead of at a
 * hand-written constant. `packRow` drops columns right-to-left when the panel is narrower than
 * this, which is the intended behaviour on a small terminal — but a panel that is never allowed
 * to reach this width drops them on a 200-column one too, silently and forever.
 */
export const POS_ROW_COLS: number =
  Object.values(POS_GRID).reduce((a, b) => a + b, 0) + Object.keys(POS_GRID).length - 1;

/**
 * Legends as columns rather than as a string, so `sectionHeader` can place each label over the
 * column it names. The leading entry is the symbol column: it is never labelled (the symbols
 * label themselves) and it exists so every following label lands on the right offset.
 */
const POS_LEGEND: Col[] = [
  { text: '', w: POS_GRID.sym },
  { text: 'px', w: POS_GRID.px, right: true },
  { text: 'cost', w: POS_GRID.cost, right: true },
  { text: 'p&l', w: POS_GRID.pnl, right: true },
  { text: 'stop', w: POS_GRID.stop, right: true },
  { text: 'tgt', w: POS_GRID.tgt, right: true },
  { text: 'val', w: POS_GRID.val, right: true },
  { text: 'qty', w: POS_GRID.qty, right: true },
  { text: 'rsi', w: POS_GRID.rsi, right: true },
  { text: 'held', w: POS_GRID.held, right: true },
];

const WATCH_LEGEND: Col[] = [
  { text: '', w: WATCH_GRID.sym },
  { text: 'px', w: WATCH_GRID.px, right: true },
  { text: 'sig', w: WATCH_GRID.sig, right: true },
  { text: 'rsi', w: WATCH_GRID.rsi, right: true },
];

function positionRow(m: DashboardModel, f: Fmt, p: PositionRow, width: number): string {
  const g = m.glyphs;
  const dim = p.stale || p.price === null;
  const stopNear = p.distanceToStopPct != null && p.distanceToStopPct <= 1;
  const targetNear = p.distanceToTargetPct != null && p.distanceToTargetPct <= 1;

  const cols: Col[] = [
    { text: p.symbol, w: POS_GRID.sym, color: dim ? 'gray-fg' : 'bold' },
    {
      text: dim ? g.stale : priceText(f, p.price),
      w: POS_GRID.px,
      right: true,
      color: dim ? 'gray-fg' : undefined,
    },
    {
      // The basis P&L is measured FROM, so px, cost and p&l on one row always agree with each
      // other: `compute.ts` prefers the journal's recorded entry price and falls back to the
      // venue's average cost, and quoting the venue's figure here instead would print a cost
      // the neighbouring percentage was not computed against.
      // Never dimmed with the rest of the row: the cost basis is a recorded fact, not a quote,
      // so a dead price feed does not make it any less known.
      text: priceText(f, p.entryPrice),
      w: POS_GRID.cost,
      right: true,
      color: 'gray-fg',
    },
    { text: f.signedPct(p.pnlPct, 1), w: POS_GRID.pnl, right: true, color: f.pnlColor(p.pnlPct) },
    {
      // Distance to stop, not the stop price: how much room is left is the decision-relevant
      // number, and it is the one `compute.ts` already derived.
      text: p.stopLevel == null ? g.dash : f.signedPct(p.distanceToStopPct, 1),
      w: POS_GRID.stop,
      right: true,
      color: p.stopLevel == null ? 'red-fg' : stopNear ? 'yellow-fg' : 'gray-fg',
    },
    {
      // Room left to the target, mirroring the stop cell so the two read on one scale. Two
      // deliberate differences: a missing target is grey where a missing stop is red — an
      // unstopped position is unwatched by the machine, an untargeted one is merely undecided —
      // and proximity is green where the stop's is yellow, because arriving here is the good
      // outcome. Once the level is through the figure goes negative and stays green, which is
      // the same news the takeProfit detector is raising an event about.
      text: p.takeProfitLevel == null ? g.dash : f.signedPct(p.distanceToTargetPct, 1),
      w: POS_GRID.tgt,
      right: true,
      color: p.takeProfitLevel == null ? 'gray-fg' : targetNear ? 'green-fg' : 'gray-fg',
    },
    {
      // What the holding is worth right now: qty times the price on this row. The one thing `qty`
      // alone cannot tell anyone — 434 shares is $38k of XLE or $4k of a $9 name — so this is the
      // column that says how much of the book a row actually is.
      //
      // Deliberately NOT a decomposition of the `inv` figure in the head: that one is
      // `equity - cash` as the VENUE reports it, this is our quote times our share count, and a
      // stale row contributes nothing here. The column adds up to roughly `inv`, never exactly,
      // and the two disagreeing is a feed telling on itself rather than an arithmetic error.
      //
      // Dimmed with the quote for the reason `px` is: a value computed from a price we are
      // refusing to show is a number the reader has no way to check.
      text: dim || p.price == null ? g.stale : valueText(f, p.qty * p.price),
      w: POS_GRID.val,
      right: true,
      color: dim ? 'gray-fg' : undefined,
    },
    { text: String(p.qty), w: POS_GRID.qty, right: true, color: 'gray-fg' },
    { text: f.fixed(p.rsi, 0), w: POS_GRID.rsi, right: true, color: 'gray-fg' },
    { text: f.duration(p.heldForMs), w: POS_GRID.held, right: true, color: 'gray-fg' },
  ];
  return packRow(f, width, cols);
}

function watchRow(m: DashboardModel, f: Fmt, entry: WatchEntry, width: number): string {
  const g = m.glyphs;
  const { row, bullish, bearish, total, composite } = entry;
  const dim = row.stale || row.price === null;

  // The composite itself, not a count and not an arrow. `+0.42` fits the same five columns
  // `↑3/5` did and says something the count cannot: five signals barely above the dead band and
  // five near +1 rendered identically before, and they are not the same setup. The sign is the
  // arrow.
  //
  // The COLOUR still comes from the counts, because `signalTally` owns the dead band that
  // decides a lean and a threshold on the composite here would be this file's second copy of
  // that judgement — the thing the header forbids. The counts read BOTH sides, never the
  // absence of one: five neutral signals have zero bullish, and painting that red would say
  // "leans bearish" about a symbol that leans nowhere.
  const lean = total === 0 ? 0 : bullish * 2 > total ? 1 : bearish * 2 > total ? -1 : 0;
  const leanColor = lean > 0 ? 'green-fg' : lean < 0 ? 'red-fg' : 'gray-fg';

  const cols: Col[] = [
    { text: row.symbol, w: WATCH_GRID.sym, color: dim ? 'gray-fg' : undefined },
    {
      text: dim ? g.stale : priceText(f, row.price),
      w: WATCH_GRID.px,
      right: true,
      color: dim ? 'gray-fg' : undefined,
    },
    {
      text: composite === null
        ? g.dash
        : `${composite >= 0 ? '+' : ''}${composite.toFixed(2)}`,
      w: WATCH_GRID.sig,
      right: true,
      color: leanColor,
    },
    { text: f.fixed(row.rsi, 0), w: WATCH_GRID.rsi, right: true, color: 'gray-fg' },
  ];
  return packRow(f, width, cols);
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

/**
 * The wide-terminal panel. Returns at most `height` lines, each exactly `width` columns.
 *
 * Row budget is spent in this order: identity (clock, venue, model) → account → lifecycle →
 * positions → watchlist. Blank separators are a luxury bought only when there is slack, and
 * the two lists share whatever is left with positions taking the larger half.
 */
export function renderSidebar(m: DashboardModel, width: number, height: number): string[] {
  if (width <= 0 || height <= 0) return [];
  const f = makeFormat(m.glyphs);
  const g = m.glyphs;
  const t = m.tick;

  // ── identity + account + lifecycle, in priority order ──
  const head: string[] = [];

  head.push(
    joinChunks(f, width, '  ', [
      { text: `${f.etClock(m.now)} ET`, color: 'bold' },
      {
        // The blink is the cheapest possible "this process is alive" signal: it costs one
        // character per second and it is the one thing on screen that cannot be a stale render.
        text: `${g.live} ${t?.session ?? 'unknown'}`,
        color: m.frame % 2 === 0 ? sessionColor(t?.session ?? '') : 'gray-fg',
      },
    ]),
  );

  head.push(
    joinChunks(f, width, ' ', [
      { text: m.env.broker || 'broker?', color: 'gray-fg' },
      { text: m.env.venue, color: m.env.venue === 'live' ? 'red-fg' : 'gray-fg' },
      { text: m.env.gate ?? '', color: 'yellow-fg' },
      { text: t ? `pol v${t.policyVersion}` : '', color: 'gray-fg' },
    ]),
  );
  head.push(joinChunks(f, width, ' ', [{ text: m.env.model || 'model?', color: 'cyan-fg' }]));

  head.push(
    joinChunks(f, width, '  ', [
      { text: f.money(t?.account.equity ?? null), color: 'bold' },
      { text: f.signedPct(t?.account.dayPnLPct ?? null), color: f.pnlColor(t?.account.dayPnLPct) },
    ]),
  );
  // How the equity above is currently split. Directly under it on purpose: `inv` and `cash` are
  // that one number decomposed, whereas buying power is a limit derived from it.
  head.push(
    joinChunks(f, width, ' · ', [
      { text: `inv ${f.money(t?.account.invested ?? null)}`, color: 'gray-fg' },
      { text: `cash ${f.money(t?.account.cash ?? null)}`, color: 'gray-fg' },
    ]),
  );
  head.push(
    joinChunks(f, width, ' · ', [
      { text: `bp ${f.money(t?.account.buyingPower ?? null)}`, color: 'gray-fg' },
      { text: t ? `${Object.keys(t.positions).length} pos` : '', color: 'gray-fg' },
    ]),
  );

  head.push(joinChunks(f, width, ' ', [laneChunk(m, m.trader, true)]));
  head.push(
    joinChunks(f, width, ' · ', [
      { text: m.cycle.n > 0 ? `cyc ${m.cycle.n}` : 'cyc —', color: 'gray-fg' },
      { text: m.cycle.lastMs != null ? f.duration(m.cycle.lastMs) : '', color: 'gray-fg' },
      { text: tokenSummary(m) ?? '', color: 'gray-fg' },
    ]),
  );
  head.push(
    joinChunks(f, width, ' · ', [
      { text: t ? `tick ${f.ageOf(t.tickAt, m.now)} ago` : 'awaiting first tick', color: 'gray-fg' },
    ]),
  );

  if (head.length >= height) return head.slice(0, height);

  // ── lists ──
  const blank = ' '.repeat(width);
  const spacious = height >= head.length + 8;
  const lines: string[] = [];
  // Sizes of the three head blocks — identity, account, lifecycle — in the order pushed above.
  // Counts rather than an index per line, so adding a line to a block is one edit here and cannot
  // silently drop or duplicate one the way hand-written `head[n]` positions could.
  const HEAD_BLOCKS = [3, 3, 3];
  const pushHead = () => {
    let at = 0;
    for (const n of HEAD_BLOCKS) {
      lines.push(...head.slice(at, at + n));
      at += n;
      if (spacious) lines.push(blank);
    }
    // A head line the block sizes forgot is still rendered, unseparated. Losing a fact off the
    // panel is the failure mode worth insuring against; a missing blank row is not.
    if (at < head.length) lines.push(...head.slice(at));
  };
  pushHead();

  let remaining = height - lines.length;
  if (remaining <= 0 || !t) return lines.slice(0, height);

  const positions = sortedPositions(t);
  const watch = sortedWatchlist(t);

  // A section costs 1 line for its header plus one per row. Positions are offered everything
  // they need first; the watchlist gets what is left, but is guaranteed a header and one row
  // whenever two lines can be spared, so it never vanishes without trace on a mid-height
  // terminal.
  const posNeed = 1 + Math.max(1, positions.length);
  const watchNeed = 1 + Math.max(1, watch.length);
  // A blank row between the two lists, on exactly the condition the head blocks use for theirs:
  // one predicate decides whether this panel is spending rows on separation at all, rather than
  // the head spending three while the lists — the part actually being separated — spend none.
  //
  // It is budgeted here, BEFORE the split, so it is a row the lists were never offered rather
  // than one taken back afterwards. When that costs a list its last row, `listBody` says so with
  // `+N more`; a separator may cost a visible row, never a silent one.
  const sep = spacious && remaining >= 5 ? 1 : 0;
  const listRows = remaining - sep;
  let posBudget = posNeed;
  let watchBudget = 0;
  if (posNeed + watchNeed <= listRows) {
    watchBudget = watchNeed;
  } else if (listRows >= 4) {
    watchBudget = Math.min(watchNeed, Math.max(2, Math.floor(listRows / 2)));
    posBudget = Math.min(posNeed, listRows - watchBudget);
  } else {
    posBudget = Math.min(posNeed, listRows);
  }

  let drewPositions = false;
  if (posBudget >= 2) {
    lines.push(sectionHeader(f, width, 'POSITIONS', positions.length, POS_LEGEND));
    lines.push(
      ...listBody(f, width, posBudget - 1, positions, (p, w) => positionRow(m, f, p, w), 'flat'),
    );
    drewPositions = true;
  }
  if (watchBudget >= 2) {
    // Only ever between two lists — a blank first row would read as a rendering fault.
    if (sep && drewPositions) lines.push(blank);
    lines.push(sectionHeader(f, width, 'WATCHLIST', watch.length, WATCH_LEGEND));
    lines.push(
      ...listBody(f, width, watchBudget - 1, watch, (e, w) => watchRow(m, f, e, w), 'empty'),
    );
  }

  return lines.slice(0, height);
}

function tokenSummary(m: DashboardModel): string | null {
  const total = (m.cycle.inTokens ?? 0) + (m.cycle.outTokens ?? 0);
  const s = tokens(total);
  return s ? `${s} tok` : null;
}

/**
 * `TITLE n` on the left, and each column's label directly above that column.
 *
 * The legend is laid out on the row's own grid and dropped right-to-left by the same rule
 * `packRow` uses, so a label can never survive for a column the rows below it stopped
 * rendering. A label whose column starts underneath the title is dropped rather than nudged
 * aside — a missing label costs the operator a guess at an obvious column, whereas a moved one
 * asserts something false about which number is which.
 */
function sectionHeader(f: Fmt, width: number, title: string, count: number, legend: Col[]): string {
  const left = `${title} ${count}`;
  const leftW = plainWidth(left);
  if (width <= leftW) return `{bold}${escapeCell(f.fit(left, width))}{/}`;

  let used = 0;
  let plain = '';
  for (const col of legend) {
    const gap = used === 0 ? 0 : 1;
    if (used + gap + col.w > width) break;
    // One blank column of separation, so a surviving label never abuts the count.
    const owned = used + gap < leftW + 1;
    const text = owned ? '' : col.text;
    plain += ' '.repeat(gap) + (col.right ? f.fitRight(text, col.w) : f.fit(text, col.w));
    used += gap + col.w;
  }
  // Padded then cut to `width`, so left + tail is exactly `width` however the loop ended.
  const tail = (plain + ' '.repeat(width)).slice(leftW, width);
  return `{bold}${escapeCell(left)}{/}{gray-fg}${escapeCell(tail)}{/}`;
}

/**
 * Render at most `budget` rows, spending the last one on `+N more` when the list is longer.
 *
 * The marker is not decoration: without it a 12-position book on a short terminal looks
 * exactly like a 6-position book, and that is the kind of silence this system is built to
 * avoid.
 */
function listBody<T>(
  f: Fmt,
  width: number,
  budget: number,
  items: T[],
  render: (item: T, width: number) => string,
  emptyLabel: string,
): string[] {
  if (budget <= 0) return [];
  if (items.length === 0) return [`{gray-fg}${escapeCell(f.fit(emptyLabel, width))}{/}`];
  if (items.length <= budget) return items.map((i) => render(i, width));
  const shown = items.slice(0, Math.max(0, budget - 1)).map((i) => render(i, width));
  const hidden = items.length - shown.length;
  shown.push(`{gray-fg}${escapeCell(f.fit(`+${hidden} more`, width))}{/}`);
  return shown;
}

// ── Events panel ──────────────────────────────────────────────────────────────

const EVENT_SYM_W = 6;
const EVENT_KIND_W = 12;
const EVENT_AGE_W = 9;
const EVENT_ACTION_W = 9;
/** Floor on the headline column so it never collapses to nothing before the trailing columns do. */
const EVENT_HEADLINE_MIN = 10;

function severityGlyph(g: Glyphs, sev: EventRow['severity']): string {
  switch (sev) {
    case 'critical':
      return g.sevCritical;
    case 'urgent':
      return g.sevUrgent;
    case 'warn':
      return g.sevWarn;
    default:
      return g.sevInfo;
  }
}

/** Full severity colour while open; dimmed once acked — same rule `positionRow` uses for a dead feed. */
function severityColor(e: EventRow): string {
  if (e.ackedAt != null) return 'gray-fg';
  switch (e.severity) {
    case 'critical':
      return 'red-fg';
    case 'urgent':
      return 'magenta-fg';
    case 'warn':
      return 'yellow-fg';
    default:
      return 'gray-fg';
  }
}

/**
 * Decide, most-important-first, which optional trailing columns fit next to the headline at this
 * width. The headline is the only column with no width of its own — it takes whatever the
 * trailing columns leave — so this has to run before either `eventRow` or the legend can lay
 * anything out, and both call it so a label is never positioned over a column its own row already
 * dropped. Least important last, so it is the first dropped as the panel narrows: suggested
 * action, then age, then kind, keeping severity+headline+symbol. No ack column: OPEN's rows are
 * unacked by construction (`needsAttention`) and RECENT ACTIVITY's ack state goes stale across a
 * restart (see `eventLog.ts`), so neither section has a truthful answer to show there.
 */
function planEventColumns(
  width: number,
): { headlineW: number; sym: boolean; kind: boolean; age: boolean; action: boolean } {
  const candidates: Array<{ key: 'sym' | 'kind' | 'age' | 'action'; w: number }> = [
    { key: 'sym', w: EVENT_SYM_W },
    { key: 'kind', w: EVENT_KIND_W },
    { key: 'age', w: EVENT_AGE_W },
    { key: 'action', w: EVENT_ACTION_W },
  ];
  const show = { sym: false, kind: false, age: false, action: false };
  let trailingW = 0;
  for (const c of candidates) {
    const next = trailingW + 1 + c.w;
    if (EVENT_HEADLINE_MIN + next > width) break;
    show[c.key] = true;
    trailingW = next;
  }
  return { headlineW: Math.max(EVENT_HEADLINE_MIN, width - trailingW), ...show };
}

/** Legend for `sectionHeader`, laid out on the exact same plan `eventRow` uses at this width. */
function eventLegend(width: number): Col[] {
  const plan = planEventColumns(width);
  const legend: Col[] = [{ text: '', w: plan.headlineW }];
  if (plan.sym) legend.push({ text: 'sym', w: EVENT_SYM_W, right: true });
  if (plan.kind) legend.push({ text: 'kind', w: EVENT_KIND_W, right: true });
  if (plan.age) legend.push({ text: 'age', w: EVENT_AGE_W, right: true });
  if (plan.action) legend.push({ text: 'action', w: EVENT_ACTION_W, right: true });
  return legend;
}

function eventRow(m: DashboardModel, f: Fmt, e: EventRow, width: number): string {
  const g = m.glyphs;
  const plan = planEventColumns(width);
  const sev = severityGlyph(g, e.severity);
  const color = severityColor(e);

  const cols: Col[] = [{ text: `${sev} ${e.headline}`, w: plan.headlineW, color }];
  if (plan.sym) cols.push({ text: e.symbol ?? g.dash, w: EVENT_SYM_W, color: 'bold' });
  if (plan.kind) cols.push({ text: e.kind.replace(/_/g, ' '), w: EVENT_KIND_W, color: 'gray-fg' });
  if (plan.age) {
    cols.push({ text: `${f.ageOf(e.firedAt, m.now)} ago`, w: EVENT_AGE_W, right: true, color: 'gray-fg' });
  }
  if (plan.action) {
    cols.push({ text: e.suggestedAction ?? g.dash, w: EVENT_ACTION_W, right: true, color: 'cyan-fg' });
  }
  return packRow(f, width, cols);
}

// ── Proposals ─────────────────────────────────────────────────────────────────

const PROPOSAL_KIND_W = 12;
const PROPOSAL_SYM_W = 6;
const PROPOSAL_AGE_W = 9;
/** Floor on the headline column, same reasoning as `EVENT_HEADLINE_MIN`. */
const PROPOSAL_HEADLINE_MIN = 10;

/** Only `pending`/`approved` are still waiting on anything — everything else is history. */
export function isOpenProposal(p: ProposalRow): boolean {
  return p.status === 'pending' || p.status === 'approved';
}

/** Soonest deadline first — that is the one an operator is about to miss. */
function sortedProposals(proposals: ProposalRow[]): ProposalRow[] {
  return [...proposals].sort((a, b) => a.expiresAt - b.expiresAt);
}

function proposalColor(status: string): string {
  switch (status) {
    case 'pending':
      return 'yellow-fg';
    case 'approved':
      return 'cyan-fg';
    case 'executed':
      return 'green-fg';
    case 'rejected':
    case 'failed':
      return 'red-fg';
    default:
      return 'gray-fg';
  }
}

/** Same reasoning as `planEventColumns`: the headline has no width of its own, so this runs first. */
function planProposalColumns(width: number): { headlineW: number; sym: boolean; kind: boolean; age: boolean } {
  const candidates: Array<{ key: 'sym' | 'kind' | 'age'; w: number }> = [
    { key: 'sym', w: PROPOSAL_SYM_W },
    { key: 'kind', w: PROPOSAL_KIND_W },
    { key: 'age', w: PROPOSAL_AGE_W },
  ];
  const show = { sym: false, kind: false, age: false };
  let trailingW = 0;
  for (const c of candidates) {
    const next = trailingW + 1 + c.w;
    if (PROPOSAL_HEADLINE_MIN + next > width) break;
    show[c.key] = true;
    trailingW = next;
  }
  return { headlineW: Math.max(PROPOSAL_HEADLINE_MIN, width - trailingW), ...show };
}

function proposalLegend(width: number): Col[] {
  const plan = planProposalColumns(width);
  const legend: Col[] = [{ text: '', w: plan.headlineW }];
  if (plan.sym) legend.push({ text: 'sym', w: PROPOSAL_SYM_W, right: true });
  if (plan.kind) legend.push({ text: 'kind', w: PROPOSAL_KIND_W, right: true });
  if (plan.age) legend.push({ text: 'expires', w: PROPOSAL_AGE_W, right: true });
  return legend;
}

function proposalRow(m: DashboardModel, f: Fmt, p: ProposalRow, width: number): string {
  const g = m.glyphs;
  const plan = planProposalColumns(width);
  const color = proposalColor(p.status);

  const cols: Col[] = [{ text: `[${p.id}] ${p.status} — ${p.reason}`, w: plan.headlineW, color }];
  if (plan.sym) cols.push({ text: p.symbol, w: PROPOSAL_SYM_W, color: 'bold' });
  if (plan.kind) cols.push({ text: p.kind.replace(/_/g, ' '), w: PROPOSAL_KIND_W, color: 'gray-fg' });
  if (plan.age) {
    const remainingMs = p.expiresAt - m.now;
    const text = !isOpenProposal(p) ? g.dash : remainingMs > 0 ? f.duration(remainingMs) : 'due';
    cols.push({ text, w: PROPOSAL_AGE_W, right: true, color: 'gray-fg' });
  }
  return packRow(f, width, cols);
}

// ── Events panel ──────────────────────────────────────────────────────────────

/**
 * The full-height inbox panel. Three independent sections, not a merge:
 *
 * PROPOSALS is a human's own queue — the only thing on this panel that only a human can move —
 * so it is drawn first and, unlike OPEN/RECENT ACTIVITY, costs nothing when empty: under the
 * default policy every action is `auto` and this store stays empty, so the panel looks exactly
 * like it did before proposals existed.
 *
 * OPEN is the live event registry (`getPendingEvents()`) filtered to `needsAttention` — an inbox
 * holds what needs a human, not every event that happens to be pending. RECENT ACTIVITY is venue
 * history, not condition noise: entries, exits, and stop/target moves, newest first, sourced from
 * the decision journal (`journal.ts`'s `readDecisions` filtered by `isTradeAction`) rather than
 * the event bus — a `data_stale`/`heartbeat`/`condition_resolved` never belongs here, only a
 * decision that actually touched the venue does. Neither section shows an ack column: OPEN's rows
 * are unacked by construction, and RECENT ACTIVITY's rows are facts, not conditions to acknowledge.
 * Row budgeting mirrors `renderSidebar`'s positions/watchlist split.
 */
export function renderEventsPanel(m: DashboardModel, width: number, height: number): string[] {
  if (width <= 0 || height <= 0) return [];
  const f = makeFormat(m.glyphs);

  const proposals = sortedProposals(m.proposals);
  const lines: string[] = [];

  if (proposals.length > 0 && height >= 2) {
    const budget = Math.min(1 + proposals.length, height);
    lines.push(sectionHeader(f, width, 'PROPOSALS', proposals.length, proposalLegend(width)));
    lines.push(
      ...listBody(f, width, budget - 1, proposals, (p, w) => proposalRow(m, f, p, w), 'nothing pending'),
    );
    if (height - lines.length >= 3) lines.push(' '.repeat(width));
  }

  const remaining = height - lines.length;
  if (remaining <= 0) return lines.slice(0, height);

  // An inbox holds what needs a human, not everything that happens to be live: `info` readings
  // and `urgent` (the trader's wake, not the operator's) are real events but not an operator's
  // problem, so OPEN excludes them via the same predicate that drives the status-bar badge.
  const open = sortedEvents(m.events.filter(needsAttention));
  const recent = [...m.eventLog].reverse();

  const openNeed = 1 + Math.max(1, open.length);
  const recentNeed = 1 + Math.max(1, recent.length);
  const sep = remaining >= openNeed + recentNeed + 1 ? 1 : 0;
  const listRows = remaining - sep;

  let openBudget = openNeed;
  let recentBudget = 0;
  if (openNeed + recentNeed <= listRows) {
    recentBudget = recentNeed;
  } else if (listRows >= 4) {
    recentBudget = Math.min(recentNeed, Math.max(2, Math.floor(listRows / 2)));
    openBudget = Math.min(openNeed, listRows - recentBudget);
  } else {
    openBudget = Math.min(openNeed, listRows);
  }

  let drewOpen = false;
  if (openBudget >= 2) {
    lines.push(sectionHeader(f, width, 'OPEN', open.length, eventLegend(width)));
    lines.push(
      ...listBody(f, width, openBudget - 1, open, (e, w) => eventRow(m, f, e, w), 'nothing open'),
    );
    drewOpen = true;
  }
  if (recentBudget >= 2) {
    if (sep && drewOpen) lines.push(' '.repeat(width));
    lines.push(sectionHeader(f, width, 'RECENT ACTIVITY', recent.length, eventLegend(width)));
    lines.push(
      ...listBody(f, width, recentBudget - 1, recent, (e, w) => eventRow(m, f, e, w), 'no history yet'),
    );
  }

  return lines.slice(0, height);
}

// ── Strip ─────────────────────────────────────────────────────────────────────

/**
 * The narrow-terminal form: always exactly three lines, dropping fields right-to-left as the
 * terminal narrows. Same facts as the sidebar, no rows — a 60-column terminal cannot hold a
 * table and a log at once, and the log is what the operator came for.
 */
export function renderStrip(m: DashboardModel, width: number): string[] {
  const f = makeFormat(m.glyphs);
  const g = m.glyphs;
  const t = m.tick;
  if (width <= 0) return ['', '', ''];

  const l1 = joinChunks(f, width, ` ${g.sep} `, [
    { text: `${f.etClock(m.now)} ET`, color: 'bold' },
    {
      text: `${g.live} ${t?.session ?? 'unknown'}`,
      color: m.frame % 2 === 0 ? sessionColor(t?.session ?? '') : 'gray-fg',
    },
    { text: m.env.model || 'model?', color: 'cyan-fg' },
    { text: `${m.env.broker} ${m.env.venue}`, color: m.env.venue === 'live' ? 'red-fg' : 'gray-fg' },
    { text: m.env.gate ?? '', color: 'yellow-fg' },
    { text: t ? `pol v${t.policyVersion}` : '', color: 'gray-fg' },
    { text: t ? `tick ${f.ageOf(t.tickAt, m.now)} ago` : 'awaiting first tick', color: 'gray-fg' },
  ]);

  const l2 = joinChunks(f, width, ` ${g.sep} `, [
    { text: f.money(t?.account.equity ?? null), color: 'bold' },
    { text: f.signedPct(t?.account.dayPnLPct ?? null), color: f.pnlColor(t?.account.dayPnLPct) },
    laneChunk(m, m.trader, true),
    { text: t ? `${Object.keys(t.positions).length} pos` : '', color: 'gray-fg' },
    { text: `bp ${f.money(t?.account.buyingPower ?? null)}`, color: 'gray-fg' },
    { text: `inv ${f.money(t?.account.invested ?? null)}`, color: 'gray-fg' },
    { text: `cash ${f.money(t?.account.cash ?? null)}`, color: 'gray-fg' },
    { text: m.cycle.n > 0 ? `cyc ${m.cycle.n}` : '', color: 'gray-fg' },
  ]);

  const l3 = t ? stripBook(m, f, width) : ' '.repeat(width);
  return [l1, l2, l3];
}

/** One line of book: held symbols with P&L, or — when flat — what is being watched. */
function stripBook(m: DashboardModel, f: Fmt, width: number): string {
  const g = m.glyphs;
  const t = m.tick!;
  const positions = sortedPositions(t);

  if (positions.length > 0) {
    return joinChunks(
      f,
      width,
      ` ${g.sep} `,
      positions.map((p) => ({
        text: `${p.symbol} ${f.signedPct(p.pnlPct, 1)}`,
        color: f.pnlColor(p.pnlPct),
      })),
    );
  }

  const watch = sortedWatchlist(t);
  return joinChunks(f, width, ' ', [
    { text: 'flat', color: 'gray-fg' },
    ...watch.map((e) => ({
      text: `${e.row.symbol}${e.composite === null ? '' : ` ${e.composite >= 0 ? '+' : ''}${e.composite.toFixed(2)}`}`,
      color: e.total > 0 && e.bullish * 2 > e.total ? 'green-fg' : 'gray-fg',
    })),
  ]);
}

// ── Status line ───────────────────────────────────────────────────────────────

/**
 * The one-line status bar. Both agents get their own lane here.
 *
 * They used to share a single `setStatus` string, which meant the concierge writing `ready`
 * erased the trader's `next cycle in 7 min` — the operator lost the countdown by asking a
 * question. Two lanes, one line, no clobbering.
 */
export function renderStatus(m: DashboardModel, width: number, panelHint: string): string {
  const f = makeFormat(m.glyphs);
  const g = m.glyphs;
  const trader = laneChunk(m, m.trader, true);
  const concierge = laneChunk(m, m.concierge, false);

  return joinChunks(f, width, ` ${g.sep} `, [
    { text: 'AutoTrade', color: 'bold' },
    { text: `trader ${trader.text}`, color: trader.color },
    { text: `concierge ${concierge.text}`, color: concierge.color },
    { text: panelHint },
    { text: 'PgUp/PgDn scroll' },
    { text: 'Ctrl+C quit' },
    // Keyboard hints last on purpose: `joinChunks` drops from the right, so on a narrow
    // terminal the lane states survive and the hints — which an operator needs once — go first.
    { text: 'Enter send' },
    { text: `${g.up}/${g.down} history` },
    { text: 'Esc clear' },
  ]);
}
