import { withAccountRead } from '../core/accountRead';
import { describeDecision } from '../journal/types';
import { readDecision } from '../journal/journal';
import { runTurn } from './turnRunner';
import { enqueueCommand, pendingCommands, updateCommand, getCommand } from '../core/commands';
import { readRecord } from '../core/storage';
import { runtimeContract } from './runtimeContract';
import { createModelProvider } from '../core/modelProvider';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { canonicalSymbol } from '../core/symbols';
import { getPolicyHash } from '../policy/load';
import { renderPolicy } from '../policy/render';
import { getPolicy } from '../policy/load';
import { getState, updateState } from '../state/state';
import { readDecisions } from '../journal/journal';
import { readLessons } from '../journal/lessons';
import { getPendingEvents, type Severity } from '../features/eventBus';
import { getOpenProposals, refreshCommandOutcome } from '../core/proposals';
import { exposure, type Exposure, type ExposurePosition } from '../strategy/exposure';
import { getFundamentalsBatch, type Fundamentals } from '../collect/fundamentals';
import type { PositionSnapshot } from '../state/state';
import { ui } from '../ui/ui';
import {
  TRADER_TOOL_DEFINITIONS,
  TRADER_REGISTRY,
  brokerOrderView,
  executeTraderTool,
  getMarketStatusSnapshot,
  getAccountSnapshot,
} from '../tools/traderTools';
import type { ChatMessage, ContentBlock } from '../core/types';
import type { OpenOrder } from '../broker/IBroker';

const MAX_ROUNDS = 30;
const DEFAULT_SLEEP_MS = 60 * 60_000;
const ERROR_RECOVERY_SLEEP_MS = 60_000;
/** Only a safety net: `resume()` and `stop()` both end a paused sleep directly. */
const PAUSED_RECHECK_MS = 60 * 60_000;

/** Policy activation validates the prompt; a later render error stops the cycle. */
function systemPrompt(): string { return runtimeContract() + "\n\nACCOUNT STRATEGY\n" + renderPolicy(); }

export class Trader {
  private running = false;
  private readonly provider = createModelProvider(config.ai);
  private wakeUp: (() => void) | null = null;
  private wakePending = false;
  private cycleCount = 0;
  private controller = new AbortController();
  private active: Promise<void> | null = null;
  private get paused(): boolean { return getState().paused; }

  async start(): Promise<void> {
    this.running = true;
    this.active = this.loop();
    await this.active;
  }
  async stop(): Promise<void> {
    this.running = false; this.controller.abort(); this.wakeUp?.();
    await this.active;
  }
  pause(): void { updateState({ paused: true }); this.controller.abort(); }
  resume(): void { updateState({ paused: false }); this.wakeUp?.(); }
  get status(): { paused: boolean; cycles: number } { return { paused: this.paused, cycles: this.cycleCount }; }
  wake(message?: string): { commandId?: string; status: string } {
    const command = message ? enqueueCommand('trader', message) : undefined;
    if (this.paused) return { commandId: command?.id, status: 'queued_paused' };
    if (this.wakeUp) this.wakeUp(); else this.wakePending = true;
    return { commandId: command?.id, status: 'queued' };
  }
  private async loop(): Promise<void> {
    while (this.running) {
      if (this.paused) {
        ui.setTraderActivity({ state: 'idle', detail: 'paused' });
        await this.interruptibleSleep(PAUSED_RECHECK_MS); continue;
      }
      let sleepMs = ERROR_RECOVERY_SLEEP_MS;
      try {
        this.cycleCount++;
        const at = Date.now();
        ui.setTraderActivity({ state: 'thinking', detail: `cycle ${this.cycleCount}` });
        const cycle = await this.runCycle();
        sleepMs = cycle.sleepMs;
        ui.setCycle({ n: this.cycleCount, lastMs: Date.now()-at, inTokens: cycle.inTokens, outTokens: cycle.outTokens });
      } catch (err: any) { logger.error('[Trader] ' + err.message); }
      if (!this.running) break;
      if (this.paused) continue;
      if (this.wakePending || (!this.paused && pendingCommands('trader').length)) { this.wakePending = false; continue; }
      ui.setTraderActivity({ state: 'sleeping', until: Date.now() + sleepMs });
      await this.interruptibleSleep(sleepMs);
    }
    ui.setTraderActivity({ state: 'idle', detail: 'stopped' });
  }
  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.wakeUp = null; resolve(); }, ms);
      this.wakeUp = () => { clearTimeout(timer); this.wakeUp = null; resolve(); };
    });
  }
  private async runCycle(): Promise<{ sleepMs: number; inTokens: number; outTokens: number }> {
    const command = pendingCommands('trader')[0] ?? enqueueCommand('trader', 'Review current incidents and portfolio under the active strategy.', 'system');
    const hash = getPolicyHash();
    this.controller = new AbortController();
    updateCommand(command.id, { status: 'running' });
    const turn = await runTurn({
      context: { role: 'trader', commandId: command.id, actorId: command.actorId },
      provider: this.provider, registry: TRADER_REGISTRY, systemPrompt: systemPrompt(), revision: hash,
      messages: async () => [{ role: 'user', content: [{ type: 'text', text: await buildCycleContext(getState(), [command.text]) }] }],
      maxRounds: config.ai.maxToolRounds, maxTokens: config.ai.maxTokensPerTurn, signal: this.controller.signal,
      beforeTool: () => { if (getState().paused || getPolicyHash() !== hash) throw new Error('Trading paused or strategy changed; review this request under the current strategy'); },
    });
    const actions = getCommand(command.id)?.actionIds ?? [];
    updateCommand(command.id, { status: turn.status === 'completed' && actions.length ? 'waiting' : turn.status,
      result: turn.error ?? (actions.length ? `Actions queued: ${actions.join(', ')}. Execution outcomes are reported separately.` : turn.text || 'Review completed; no trade action was queued.') });
    if (turn.status === 'completed' && actions.length) refreshCommandOutcome(command.id);
    return { sleepMs: turn.sleepMs ?? DEFAULT_SLEEP_MS, inTokens: turn.inTokens, outTokens: turn.outTokens };
  }
}

// ── Context builder ───────────────────────────────────────────────────────────

/** Beyond this a rationale stops being a reminder and starts being the block. */
const MAX_RATIONALE_CHARS = 140;

/**
 * How close a print has to be before it is worth a line on a held row. Fourteen days is roughly
 * the horizon a multi-day momentum hold can actually reach, and past it the annotation would be
 * on every row every cycle — noise crowding out the rules above it. `get_calendar` answers for
 * any date at any distance; this is only about what is worth saying unasked.
 */
const EARNINGS_HORIZON_DAYS = 14;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

/** "3d" / "4h" / "12m". Coarse on purpose — the decision turns on the order of magnitude. */
function ageOf(openedAt: string): string | null {
  const ms = Date.now() - Date.parse(openedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = ms / 60_000;
  if (mins < 60) return `${Math.round(mins)}m`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function signed(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

/**
 * The book, as measured. VENUE-FIRST.
 *
 * Three things the model cannot otherwise obtain, and each was previously ASKED for by the
 * prompt without being supplied:
 *  - weight and sector, so "avoid sector concentration" is a judgment about numbers;
 *  - the entry rationale, so "exit when the thesis is done" is a judgment about the thesis
 *    rather than about the P&L — resolved through `entryDecisionId`, never reconstructed;
 *  - MFE/MAE, because "+0.4% now, +6.1% at best" and "+0.4% and never higher" are different
 *    decisions that used to render identically.
 *
 * The row set is driven by the VENUE, with `state.positionSnapshots` joined in — not the
 * other way round. This used to iterate the snapshot map behind an `entries.length === 0`
 * early return, which meant an empty or unrecognised snapshot map rendered NOTHING: measured
 * against a live account holding six positions and 29.5% of equity, the whole block vanished,
 * taking the "held at the venue with nothing recorded here" warning with it. A fresh install,
 * a new account, or a state file the operator moved aside is exactly the case where the model
 * most needs to be told what it is holding, and silence reads as flat.
 *
 * So the venue can never be invisible, and the two silences are kept distinct: an empty book
 * that exposure CONFIRMED renders nothing, while a book nobody could read says so.
 */
async function buildPortfolioContext(
  snapshots: Record<string, PositionSnapshot>,
): Promise<string> {
  // Read before the empty check, not after: what the venue holds is the question, and the
  // snapshot map is only this system's memory of it. Costs one read on a flat book.
  // A live read may fail, and a context builder must never take down a cycle — on a throw
  // the block renders without the measured columns and says so.
  let exp: Exposure | null = null;
  let exposureError: string | null = null;
  try {
    exp = await exposure();
  } catch (err: any) {
    exposureError = err.message;
    logger.warn(`[Trader] Exposure unavailable for cycle context: ${err.message}`);
  }

  // Joined on the canonical symbol: the snapshot may carry the spelling the order was placed
  // with (`BTC/USD`) while the venue reports `BTCUSD`, and an unjoined row silently renders as
  // "sector unknown" for a position whose sector is known one line further down.
  const snapByKey = new Map(
    Object.values(snapshots).map(s => [canonicalSymbol(s.symbol), s] as const),
  );

  // Venue positions first, then any snapshot the venue did not confirm. A row with no
  // snapshot is a holding this system has no baselines for; a row with no venue position is
  // a leftover. Both have to be visible, and neither may be inferred into the other.
  const rows: Array<{ label: string; snap?: PositionSnapshot; e?: ExposurePosition }> = [];
  const claimed = new Set<string>();
  for (const e of exp?.positions ?? []) {
    const snap = snapByKey.get(canonicalSymbol(e.symbol));
    if (snap) claimed.add(canonicalSymbol(e.symbol));
    rows.push({ label: snap?.symbol ?? e.symbol, snap, e });
  }
  for (const snap of Object.values(snapshots)) {
    if (claimed.has(canonicalSymbol(snap.symbol))) continue;
    rows.push({ label: snap.symbol, snap });
  }

  if (rows.length === 0) {
    // Nothing recorded and nothing to join it against. If exposure ANSWERED, the book really
    // is empty and there is nothing to say. If it threw, "no positions" and "no answer" are
    // not the same fact, and the second one has to be stated.
    if (exp) return '';
    return [
      '=== PORTFOLIO CONTEXT ===',
      `Nothing recorded here, and the venue could not be read this cycle (${exposureError}).`,
      'This is NOT a claim that the book is empty — call get_positions before acting.',
      '=== END PORTFOLIO CONTEXT ===',
    ].join('\n');
  }

  const lines = ['=== PORTFOLIO CONTEXT ==='];

  // Resolved by id, not from a recent window. A `limit` would buy nothing — `readDecisions`
  // parses the whole file either way and only slices the tail — while costing exactly the
  // theses that matter most: a two-day-old position sits behind a busy day's ~100 hold
  // records, so a 200-record page rendered its thesis as "not recorded" while the link was
  // sitting in the journal. Read once per cycle, and not at all when nothing is linked.
  const needed = new Set(
    rows.map(r => r.snap?.entryDecisionId).filter((id): id is string => id != null),
  );
  const theses = new Map(
    needed.size === 0
      ? []
      : [...needed].map(id => readDecision(id)).filter((r): r is NonNullable<typeof r> => !!r).map(r => [r.id, r] as const),
  );

  // One batched resolve for every venue-confirmed holding, BEFORE the loop — never a fetch
  // inside it. Same discipline as `getSectors`, and the same O(n)-fetches invariant
  // `src/strategy/exposure.ts` documents. After the first cycle the day's cache makes it free.
  //
  // Wrapped, like the exposure read above: a context builder must never take down a cycle, and
  // an unreachable Yahoo means the annotation is absent, not that no earnings are scheduled.
  // Nothing is said in that case — an absent annotation already reads as "nothing inside the
  // window", so announcing the failure on every row would put a Yahoo outage in front of the
  // model instead of the book. `get_calendar` remains available to ask directly.
  let earnings: Record<string, Fundamentals | null> = {};
  const heldSymbols = rows.filter(r => r.e).map(r => r.e!.symbol);
  if (heldSymbols.length > 0) {
    try {
      earnings = await getFundamentalsBatch(heldSymbols);
    } catch (err: any) {
      logger.warn(`[Trader] Earnings calendar unavailable for cycle context: ${err.message}`);
    }
  }

  for (const { label, snap, e } of rows) {
    const entry = snap?.entryPrice != null ? ` entry $${snap.entryPrice.toFixed(2)}` : '';
    const stop = snap?.stopLevel != null ? ` SL $${snap.stopLevel.toFixed(2)}` : '';
    const tp = snap?.takeProfitLevel != null ? ` TP $${snap.takeProfitLevel.toFixed(2)}` : '';

    const qty = e ? `  qty ${e.qty}` : '';
    // Live P&L, not MFE/MAE — the venue's own number, straight through from `Position`. Absent
    // rather than 0 when the venue didn't report one, same as sector.
    const livePnl = e?.unrealizedPnL != null
      ? `  ${e.unrealizedPnL >= 0 ? '+$' : '-$'}${Math.abs(e.unrealizedPnL).toFixed(2)}`
      : '';
    const weight = e ? `  ${e.weightPct.toFixed(1)}%` : '';
    const sector = e ? `  ${e.sector ?? '(sector unknown)'}` : '';
    const age = snap?.openedAt ? ageOf(snap.openedAt) : null;
    // Rendering a leftover like a holding invites an exit for something already gone; rendering
    // an unstopped holding like a normal row hides that no stop exists to measure against.
    // Keyed on the MISSING STOP, not on a missing snapshot: `stopBreachDetector` skips on
    // `stopLevel === null` regardless of whether a snapshot exists, so a snapshot that predates
    // entry baselines (measured: NVDA, a live holding) is exactly as unwatched as one with no
    // snapshot at all (XLF) and used to render as a clean row.
    const flag = e && snap?.stopLevel == null
      ? '  NO STOP RECORDED HERE'
      : exp && !e ? '  NO LIVE POSITION AT THE VENUE' : '';

    // Gated on `e`, like `weight` and `sector`: a venue-confirmed holding only. `(est)` is
    // carried through because an unconfirmed date is a different input to a hold decision than
    // a confirmed one, and a countdown that hides which it is invites treating a guess as a fact.
    //
    // Day zero reads as `EARNINGS TODAY`, not `EARNINGS IN 0D`: the highest-stakes row in the
    // block is the one a skimming reader is most likely to mistake for a countdown with room
    // left in it.
    const cal = e ? earnings[e.symbol]?.calendar : undefined;
    const dUntil = cal?.daysUntil;
    const earningsFlag = dUntil != null && dUntil <= EARNINGS_HORIZON_DAYS
      ? `  ${dUntil <= 0 ? 'EARNINGS TODAY' : `EARNINGS IN ${dUntil}D`}${cal!.isEstimate === true ? ' (est)' : ''}`
      : '';
    lines.push(`  ${label.padEnd(8)}${entry}${stop}${tp}${qty}${livePnl}${weight}${sector}${age ? `  age ${age}` : ''}${flag}${earningsFlag}`);

    // MFE/MAE from the same three fields `compute.ts` uses, so the numbers agree. A missing
    // baseline omits the clause rather than printing NaN.
    const parts: string[] = [];
    if (snap?.entryPrice != null && snap.entryPrice > 0) {
      const mfe = snap.sessionHigh != null
        ? signed(((snap.sessionHigh - snap.entryPrice) / snap.entryPrice) * 100) : null;
      const mae = snap.sessionLow != null
        ? signed(((snap.sessionLow - snap.entryPrice) / snap.entryPrice) * 100) : null;
      if (mfe || mae) {
        parts.push(`MFE ${mfe ?? 'n/a'} / MAE ${mae ?? 'n/a'}`);
      }
    }
    const thesis = snap?.entryDecisionId ? theses.get(snap.entryDecisionId) : undefined;
    parts.push(
      thesis ? `"${truncate(thesis.rationale, MAX_RATIONALE_CHARS)}"` : 'rationale not recorded',
    );
    lines.push(`          ${parts.join(' — ')}`);
  }

  // Counted at the VENUE when exposure answered, not from the snapshot map. The two can differ —
  // a leftover snapshot, or a holding opened before this system recorded baselines — and the
  // snapshot count is what produced "-2 slots remaining" for a book of six. The guard in
  // `enterPosition` counts broker positions, so this is also the number that will be enforced.
  const count = exp ? exp.positions.length : rows.length;
  const slotsLeft = Math.max(0, getPolicy().risk.maxPositions - count);
  lines.push(`${count} open position${count !== 1 ? 's' : ''}${exp ? ' at the venue' : ''} — ${slotsLeft} slot${slotsLeft !== 1 ? 's' : ''} remaining.${exp ? '' : ' Call get_positions for live qty and P&L.'}`);

  // Restated as a list, because a per-row flag is easy to read past and this is the one
  // condition where a stop detector has no level to compare against — it measures nothing
  // and reports nothing, which is indistinguishable from a position behaving well.
  const unstopped = rows.filter(r => r.e && r.snap?.stopLevel == null).map(r => r.label);
  if (unstopped.length > 0) {
    lines.push(`Held at the venue with no stop recorded here — the stop detector has no level to compare against and will report nothing, and since the venue stop is placed FROM that level, this system has armed nothing at the venue either: ${unstopped.join(', ')}. Unmanaged holdings need explicit human adoption. For managed holdings inspect broker protection before proposing an adjustment.`);
  }

  if (exp) {
    lines.push(
      `Deployed ${exp.grossDeployedPct.toFixed(1)}% of equity.` +
      (exp.maxWeightSymbol ? ` Max weight ${exp.maxWeightSymbol} ${exp.maxWeightPct.toFixed(1)}%.` : '') +
      (exp.maxSectorName ? ` Max sector ${exp.maxSectorName} ${exp.maxSectorWeightPct.toFixed(1)}%.` : '') +
      ` HHI ${exp.hhi.toFixed(2)}.`,
    );
    if (exp.maxHeldPair) {
      lines.push(`Max held correlation ${exp.maxHeldCorrelation.toFixed(2)} (${exp.maxHeldPair[0]}/${exp.maxHeldPair[1]}).`);
    }
    if (exp.caveats.length > 0) {
      lines.push(`Caveats: ${exp.caveats.join('; ')}.`);
    }
    lines.push('get_exposure for the full breakdown.');
  } else {
    lines.push(`Exposure unavailable this cycle (${exposureError}) — weights, sectors and concentration are unknown. Retry with get_exposure.`);
  }

  lines.push('=== END PORTFOLIO CONTEXT ===');
  return lines.join('\n');
}

/**
 * Market clock + account state, fetched once per cycle so `get_market_status` / `get_account`
 * are an on-demand refresh rather than a mandatory first step. Same fail-soft shape as
 * `buildBrokerOrders`: a broker hiccup here must not cost the cycle the rest of its context.
 * Absorbs the old standalone "Start-of-day equity" line — `getAccountSnapshot()` already
 * carries it, computed the same way `dailyLossStatus` does for the real guard.
 */
async function buildAccountStatus(): Promise<string> {
  const lines = ['=== MARKET & ACCOUNT ==='];

  try {
    const market = await getMarketStatusSnapshot();
    const untilClause = market.minutesUntilChange != null
      ? ` ${market.minutesUntilChange}m to ${market.changeLabel}.`
      : ` Next change: ${market.changeLabel}.`;
    lines.push(`Market ${market.isOpen ? 'OPEN' : 'CLOSED'} — ${market.etTime} ET.${untilClause}`);
  } catch (err: any) {
    lines.push(`Market clock unavailable this cycle (${err.message}). Retry with get_market_status.`);
  }

  try {
    const account = await getAccountSnapshot();
    lines.push(
      `Equity $${account.equity.toFixed(2)}  Cash $${account.cash.toFixed(2)}  Buying power $${account.buyingPower.toFixed(2)}.`,
    );
    const startEquityStr = account.startOfDayEquity != null
      ? `$${account.startOfDayEquity.toFixed(2)}`
      : 'unknown — waiting for the account reset';
    const dayPnlStr = account.dailyPnL != null
      ? ` Day P&L ${account.dailyPnL >= 0 ? '+' : ''}$${account.dailyPnL.toFixed(2)}` +
        (account.dailyPnLPct != null ? ` (${signed(account.dailyPnLPct)}).` : '.')
      : '';
    lines.push(`Start-of-day equity: ${startEquityStr}.${dayPnlStr}`);

    // Loud on purpose, matching the `NO STOP RECORDED HERE` treatment — this is the one state
    // where entries are blocked and a model skimming past a plain sentence would miss why.
    if (account.lossLimitBreached === true) {
      lines.push(`*** DAILY LOSS LIMIT BREACHED (limit ${account.lossLimitPct.toFixed(1)}%) — entries are blocked, exits are not. ***`);
    } else if (account.lossLimitUnmeasurable) {
      lines.push(account.lossLimitUnmeasurable);
    }
    lines.push(`Max positions: ${account.maxPositions}.`);
  } catch (err: any) {
    lines.push(`Account unavailable this cycle (${err.message}) — equity, cash and daily loss status are unknown. Retry with get_account.`);
  }

  lines.push('=== END MARKET & ACCOUNT ===');
  return lines.join('\n');
}

/** critical first, then urgent, then warn. `info` never reaches the renderer. */
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, urgent: 1, warn: 2, info: 3 };

/** Beyond this the block stops being a summary. The rest are one tool call away. */
const MAX_EVENT_LINES = 10;

/**
 * What the machine noticed since the last cycle.
 *
 * A SUMMARY, deliberately: one line per event, and `evidence` is not rendered at all —
 * that is `get_pending_events`' job. The block competes for context with everything else
 * in the cycle, and a dozen events' worth of evidence objects would crowd out the
 * portfolio it is supposed to be read against.
 *
 * `event.id` is verbatim because it is the ack handle: a reformatted id is an id the model
 * cannot pass back to `ack_event`, and the escalation ladder would climb forever.
 */
function buildMachineEvents(): string {
  const events = getPendingEvents();
  if (events.length === 0) return '';

  // `info` is context, not an incident — it accumulates as a count so an overnight of
  // heartbeats cannot push a live warn off the end of the list.
  //
  // `condition_resolved` is the exception, and it is why the exception exists: an all-clear
  // is deliberately `info` so it wakes nobody, but a filtered all-clear is no all-clear at
  // all — the model would be told about every breach and never about a recovery. Being
  // `info` still sorts it last, so under MAX_EVENT_LINES pressure the calm news is what
  // gets dropped first, which is the right order.
  const shown = events
    .filter(e => e.severity !== 'info' || e.kind === 'condition_resolved')
    .sort((a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.firedAt.localeCompare(b.firedAt),
    );
  const infoCount = events.length - shown.length;

  const lines = [`=== MACHINE EVENTS (${events.length} pending) ===`];

  for (const e of shown.slice(0, MAX_EVENT_LINES)) {
    const action = e.suggestedAction ? ` -> ${e.suggestedAction}` : '';
    lines.push(
      `[${e.id}] ${e.severity.toUpperCase().padEnd(8)} x${e.wakeCount} — ${e.headline}${action}`,
    );
  }

  if (shown.length > MAX_EVENT_LINES) {
    lines.push(`+${shown.length - MAX_EVENT_LINES} more of the same or lower severity.`);
  }
  if (infoCount > 0) {
    lines.push(`${infoCount} info event(s) not shown.`);
  }

  lines.push('get_pending_events for the numbers behind a headline; ack_event(id, disposition) for every event you deal with, including ones you decide to ignore.');
  lines.push('=== END MACHINE EVENTS ===');
  return lines.join('\n');
}

/**
 * Proposals the automation policy is holding for a human to decide, and any that a human has
 * already decided but the executor hasn't gotten to yet. Read-only for the trader — there is no
 * tool to approve or reject one, on purpose, so this block exists only to make what is already
 * waiting visible across cycle boundaries, not to invite the model to act on it.
 */
function buildPendingProposals(): string {
  const proposals = getOpenProposals();
  if (proposals.length === 0) return '';

  const lines = [`=== PENDING PROPOSALS (${proposals.length}) ===`];

  for (const p of proposals) {
    const remainingMs = p.expiresAt - Date.now();
    const remaining = remainingMs > 0 ? `expires in ${Math.round(remainingMs / 60_000)}m` : 'past expiry, awaiting sweep';
    lines.push(`[${p.id}] ${p.status.toUpperCase()} ${p.kind} ${p.symbol} — ${p.reason} (${remaining})`);
  }

  lines.push('Only PENDING actions await human approval. Automatic, submitted, partial and unknown actions have their own execution states. get_proposals provides details and confirmed outcomes.');
  lines.push('=== END PENDING PROPOSALS ===');
  return lines.join('\n');
}

/** Beyond this it stops being a summary. `get_journal` reaches the rest. */
const MAX_DECISION_LINES = 8;

/**
 * What this system decided, and why.
 *
 * This replaced three separate blocks — a research cache, a trade list and a computed
 * "performance mode". They were prose the model had written about itself, re-read as
 * fact. These are records: one line per decision, including the ones where nothing
 * happened, which are the ones a trade list can never show.
 */
function buildDecisionHistory(): string {
  const records = readDecisions({ limit: MAX_DECISION_LINES });
  if (records.length === 0) return '';

  const lines = ['=== RECENT DECISIONS ==='];
  for (const r of records) {
    const qty = r.qty != null && r.price != null ? ` ${r.qty}sh @ $${r.price.toFixed(2)}` : '';
    const pnl = r.pnl != null ? ` P&L $${r.pnl.toFixed(2)}` : '';
    const why = r.vetoRule ? ` [${r.vetoRule}]` : r.venueMessage ? ` [${r.venueMessage}]` : '';
    lines.push(
      `  ${r.at.slice(0,16)} ${describeDecision(r)}${why}`,
    );
  }
  lines.push('get_journal(symbol?, limit?) for the full history.');
  lines.push('=== END RECENT DECISIONS ===');
  return lines.join('\n');
}

/**
 * Beyond this the block stops being a standing memory and starts being an archive. Nothing
 * reaches past it on purpose: there is no `get_lessons` tool, so the model cannot claim to
 * have read a lesson it was not shown — the same trap `get_signals` was added to close, where
 * naming a vocabulary without a way to populate it invited the model to fill it in.
 */
const MAX_LESSONS = 20;

/**
 * What this system concluded, and still believes.
 *
 * The only edge in the loop that survives a cycle boundary. RECENT DECISIONS says what was
 * done, `get_scorecard` measures how it turned out, and both are re-derived from files every
 * cycle — but an INFERENCE drawn from them existed only inside the cycle that drew it. These
 * are those inferences, in the model's own words, carried forward.
 *
 * Rendered in full rather than summarized, unlike events and decisions: a lesson compressed
 * to a headline is a slogan, and the reasoning is the part that makes it applicable.
 */
/**
 * What is actually resting at the venue.
 *
 * Rendered EVERY cycle, including when the book is empty, and that is the point: this section
 * exists because the model asserted a "bracket in place" for positions that had none, and the
 * correction has to be present unprompted rather than waiting for someone to ask.
 *
 * The correction has changed shape. A stop IS now sent to the venue, so the false claim to guard
 * against is no longer "the broker is protecting you" — it is the assumption that a level recorded
 * here is necessarily resting there. Two separate facts, never merged into "protected", because
 * which of the two holds the stop determines who exits: the detector while this runs, or the venue
 * while it does not.
 */
async function buildBrokerOrders(): Promise<string> {
  const lines = ['=== BROKER ORDERS ==='];
  lines.push('Broker orders below are observations. Ownership is established by recorded order ID, not by price. Stops and targets may fill without an execute_exit call.');

  let view: Awaited<ReturnType<typeof brokerOrderView>>;
  try {
    view = await brokerOrderView();
  } catch (err: any) {
    // Fail soft: a broker hiccup must not cost the cycle its whole context.
    lines.push(`Unavailable this cycle (${err.message}) — what rests at the venue is unknown. Retry with get_open_orders.`);
    lines.push('=== END BROKER ORDERS ===');
    return lines.join('\n');
  }

  if (view.orders.length === 0) {
    lines.push('Nothing is resting at the venue. Every stop is a level in this system only, watched by the breach detector while this process runs and by nothing at all while it does not.');
  } else {
    for (const row of view.byPosition) {
      for (const o of row.orders) {
        lines.push(`  ${row.symbol.padEnd(8)}${describeOrder(o)}`);
      }
    }
    for (const o of view.ordersWithoutPosition) {
      lines.push(`  ${o.symbol.padEnd(8)}${describeOrder(o)}  NO OPEN POSITION`);
    }
    // The second axis, restated as a list for the same reason PORTFOLIO CONTEXT restates
    // `unstopped`: a per-row absence is easy to read past, and this one is the difference between
    // protected-while-watched and protected-full-stop.
    const noVenueStop = view.byPosition
      .filter(r => r.stopLevelRecordedHere != null && r.venueStop == null)
      .map(r => r.symbol);
    if (noVenueStop.length > 0) {
      lines.push(`SL recorded here but NO stop resting at the venue — protected only while this process runs: ${noVenueStop.join(', ')}. Inspect the protection status and unresolved actions; unsupported holdings require operator review.`);
    }

    for (const m of view.stopMismatches) {
      lines.push(
        m.kind === 'ours'
          ? `${m.symbol}: DEFECT — this system's own stop rests at the venue at $${m.atVenue.toFixed(2)} while the SL recorded here is $${m.recordedHere.toFixed(2)}. One order, two accounts of it; the venue's is what will fire.`
          : `${m.symbol}: SL recorded here $${m.recordedHere.toFixed(2)}, and a stop placed outside this system rests at the venue at $${m.atVenue.toFixed(2)}. Both are real and they are different levels.`,
      );
    }
  }

  lines.push('=== END BROKER ORDERS ===');
  return lines.join('\n');
}

function describeOrder(o: OpenOrder): string {
  const price =
    o.stopPrice    != null ? ` @ $${o.stopPrice.toFixed(2)}`
    : o.limitPrice != null ? ` @ $${o.limitPrice.toFixed(2)}`
    : o.trailPercent != null ? ` trail ${o.trailPercent}%`
    : o.trailAmount  != null ? ` trail $${o.trailAmount}`
    : '';
  const filled = o.filled > 0 ? ` (${o.filled}/${o.qty} filled)` : '';
  return `${o.side} ${o.qty} ${o.type === 'other' ? o.rawType : o.type}${price}${o.tif ? ` ${o.tif}` : ''} ${o.status}${filled}`;
}

function buildLessons(): string {
  const all = readLessons(20);
  if (all.length === 0) return '';

  const shown = all.slice(-MAX_LESSONS);
  const lines = [`=== LESSONS (${shown.length}${all.length > shown.length ? ` of ${all.length}` : ''}) ===`];
  lines.push('Research observations from previous cycles. These are suggestions, not permissions or binding rules. The active strategy and account mandate always take precedence.');
  for (const lesson of shown) {
    lines.push('');
    lines.push(lesson.slice(0,600));
  }
  lines.push('=== END LESSONS ===');
  return lines.join('\n');
}

/**
 * Exported as a probe seam. `verify:policy` renders the system half of the prompt without a
 * daemon; this is the user half, and every block in it is prose the model will read as fact —
 * so it has to be readable without starting a trading loop to see it.
 */
async function renderCycleContext(
  state: ReturnType<typeof getState>,
  pendingMessages: string[],
): Promise<string> {
  const lines: string[] = [`=== CYCLE: ${new Date().toISOString()} ===`];

  if (pendingMessages.length > 0) {
    lines.push('');
    lines.push('=== OPERATOR INSTRUCTIONS ===');
    pendingMessages.forEach(m => lines.push(`> ${m}`));
    lines.push('=== END OPERATOR INSTRUCTIONS ===');
    lines.push('Act on these instructions as part of this cycle.');
  }

  // First, before any of the standing bookkeeping: the events are the reason this cycle
  // exists at all, and a wake whose trigger is buried under the portfolio reads as a
  // routine periodic check.
  const eventCtx = buildMachineEvents();
  if (eventCtx) { lines.push(eventCtx); lines.push(''); }

  const proposalCtx = buildPendingProposals();
  if (proposalCtx) { lines.push(proposalCtx); lines.push(''); }

  lines.push(await buildAccountStatus());

  const portfolioCtx = await buildPortfolioContext(state.positionSnapshots);
  if (portfolioCtx) { lines.push(''); lines.push(portfolioCtx); }

  // Directly after the portfolio, because it is a statement about those same positions —
  // and unconditional, since "nothing is resting at the venue" is the fact that most needs
  // saying.
  lines.push('');
  lines.push(await buildBrokerOrders());

  const historyCtx = buildDecisionHistory();
  if (historyCtx) { lines.push(''); lines.push(historyCtx); }

  const lessonsCtx = buildLessons();
  if (lessonsCtx) { lines.push(''); lines.push(lessonsCtx); }



  lines.push('');
  lines.push('If MACHINE EVENTS are present, deal with the critical and urgent ones before anything else. Otherwise start from MARKET & ACCOUNT and PORTFOLIO CONTEXT above — get_market_status / get_account / get_positions are for a fresher read on demand, not a mandatory first step. End with sleep().');

  return lines.join('\n');
}


export function buildCycleContext(state: ReturnType<typeof getState>, pendingMessages: string[]): Promise<string> {
  return withAccountRead(() => renderCycleContext(state, pendingMessages));
}
