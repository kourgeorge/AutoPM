import { createModelProvider } from '../core/modelProvider';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { renderPolicy } from '../policy/render';
import { getPolicy } from '../policy/load';
import { getState } from '../state/state';
import { readDecisions } from '../journal/journal';
import { readLessons } from '../journal/lessons';
import { getPendingEvents, type Severity } from '../features/eventBus';
import { exposure, type Exposure } from '../strategy/exposure';
import type { PositionSnapshot } from '../state/state';
import { ui } from '../ui/ui';
import {
  TRADER_TOOL_DEFINITIONS,
  executeTraderTool,
} from '../tools/traderTools';
import type { ChatMessage, ContentBlock } from '../core/types';

const MAX_ROUNDS = 30;
const DEFAULT_SLEEP_MS = 10 * 60_000;
const ERROR_RECOVERY_SLEEP_MS = 60_000;

/**
 * The L3 system prompt: policy/POLICY.md rendered against the active policy.
 *
 * `renderPolicy` throws on an unknown placeholder or a bad filter, and POLICY.md is
 * NOT covered by the guarded reload path that protects policy.yaml — so a prose typo
 * would otherwise brick the trading loop. The last good prompt is kept and reused;
 * the FIRST render still throws, because trading on a prompt nobody could produce is
 * worse than not trading.
 */
let _lastGoodPrompt: string | null = null;

function systemPrompt(): string {
  try {
    return (_lastGoodPrompt = renderPolicy());
  } catch (err: any) {
    logger.error('[Trader] POLICY.md render failed — using last good prompt', err.message);
    if (!_lastGoodPrompt) throw err;
    return _lastGoodPrompt;
  }
}

export class Trader {
  private running = false;
  private readonly provider = createModelProvider(config.ai);
  private readonly pendingMessages: string[] = [];
  private wakeUp: (() => void) | null = null;
  /**
   * A wake that arrived while a cycle was running.
   *
   * `wakeUp` is only set during `interruptibleSleep`, so before this flag existed every
   * wake during a cycle was silently discarded — precisely the wakes that matter, since a
   * cycle is when the market is being acted on. The next sleep is skipped instead of the
   * running cycle being aborted: interrupting between `execute_entry` and the baseline
   * write would leave a filled order with no stop recorded anywhere.
   */
  private wakePending = false;

  async start(): Promise<void> {
    this.running = true;
    logger.info('='.repeat(60));
    logger.info('Trader started');
    logger.info('='.repeat(60));
    await this.loop();
  }

  stop(): void {
    this.running = false;
    this.wakeUp?.();
  }

  /**
   * Wake the trader from sleep. Optionally inject an instruction that
   * will appear in the next cycle context (sent by the concierge on behalf
   * of the operator).
   */
  wake(message?: string): void {
    if (message) {
      this.pendingMessages.push(message);
      logger.info(`[Trader] Instruction queued: "${message}"`);
    }
    if (this.wakeUp) {
      logger.info('[Trader] Waking for next cycle');
      this.wakeUp();
    } else {
      logger.info('[Trader] Wake arrived mid-cycle — next sleep will be skipped');
      this.wakePending = true;
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        ui.setStatus('thinking…');
        let sleepMs = await this.runCycle();
        if (this.wakePending) {
          this.wakePending = false;
          logger.info('[Trader] Wake was pending — starting the next cycle immediately');
          sleepMs = 0;
        }
        const mins = (sleepMs / 60_000).toFixed(0);
        logger.info(`[Trader] Sleeping ${mins} min`);
        ui.setStatus(`sleeping — next cycle in ${mins} min`);
        await this.interruptibleSleep(sleepMs);
      } catch (err: any) {
        logger.error(`[Trader] Cycle error: ${err.message}`);
        ui.setStatus('error — retrying in 1 min');
        await this.interruptibleSleep(ERROR_RECOVERY_SLEEP_MS);
      }
    }
    logger.info('[Trader] Stopped.');
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.wakeUp = null; resolve(); }, ms);
      this.wakeUp = () => { clearTimeout(timer); this.wakeUp = null; resolve(); };
    });
  }

  private async runCycle(): Promise<number> {
    const state = getState();
    const pendingMessages = this.pendingMessages.splice(0);

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: await buildCycleContext(state, pendingMessages) }],
      },
    ];

    let scheduledSleepMs = DEFAULT_SLEEP_MS;
    // Rendered per cycle, so a hot POLICY.md edit takes effect on the next one.
    const prompt = systemPrompt();

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await this.provider.chat({
        systemPrompt: prompt,
        messages,
        tools: TRADER_TOOL_DEFINITIONS,
        maxTokens: 4096,
      });

      messages.push({ role: 'assistant', content: response.content });

      if (response.stopReason === 'tool_use') {
        const toolBlocks = response.content.filter(
          (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
        );

        let sleepCalled = false;
        const results: ContentBlock[] = [];

        for (const block of toolBlocks) {
          if (block.name === 'sleep') {
            const minutes = (block.input.minutes as number) ?? 10;
            scheduledSleepMs = minutes * 60_000;
            sleepCalled = true;
            logger.info(`[Trader] Next cycle in ${minutes} min — ${block.input.reason}`);
            results.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify({ ok: true, nextCycleIn: `${minutes} min` }),
            });
          } else {
            const result = await executeTraderTool(block.name, block.input);
            logger.tool('Trader', block.name, result);
            results.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result,
            });
          }
        }

        messages.push({ role: 'user', content: results });

        if (sleepCalled) break;
        continue;
      }

      // end_turn or max_tokens
      break;
    }

    return scheduledSleepMs;
  }
}

// ── Context builder ───────────────────────────────────────────────────────────

/** Beyond this a rationale stops being a reminder and starts being the block. */
const MAX_RATIONALE_CHARS = 140;

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

/**
 * Join key between a position snapshot and a venue position.
 *
 * Crypto is the whole reason: an order placed as `BTC/USD` comes back from Alpaca as `BTCUSD`.
 * Deliberately not exported — this is a rendering convenience for one block, not a claim that
 * the system has a canonical symbol form.
 */
function normalizeSymbol(s: string): string {
  return s.replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

function signed(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

/**
 * The book, as measured.
 *
 * Three things the model cannot otherwise obtain, and each was previously ASKED for by the
 * prompt without being supplied:
 *  - weight and sector, so "avoid sector concentration" is a judgment about numbers;
 *  - the entry rationale, so "exit when the thesis is done" is a judgment about the thesis
 *    rather than about the P&L — resolved through `entryDecisionId`, never reconstructed;
 *  - MFE/MAE, because "+0.4% now, +6.1% at best" and "+0.4% and never higher" are different
 *    decisions that used to render identically.
 */
async function buildPortfolioContext(
  snapshots: Record<string, PositionSnapshot>,
): Promise<string> {
  const entries = Object.values(snapshots);
  if (entries.length === 0) return '';

  const lines = ['=== PORTFOLIO CONTEXT ==='];

  // Exposure is a live read and may fail. A context builder must never take down a cycle:
  // on a throw the block renders without the measured columns and says so.
  let exp: Exposure | null = null;
  let exposureError: string | null = null;
  try {
    exp = await exposure();
  } catch (err: any) {
    exposureError = err.message;
    logger.warn(`[Trader] Exposure unavailable for cycle context: ${err.message}`);
  }
  // Joined on a normalized symbol: the snapshot is keyed as the order was placed (`BTC/USD`)
  // while the venue reports `BTCUSD`, and an unjoined row silently renders as "sector unknown"
  // for a position whose sector is known one line further down.
  const bySymbol = new Map(exp?.positions.map(p => [normalizeSymbol(p.symbol), p]) ?? []);
  const matched = new Set<string>();

  // Resolved by id, not from a recent window. A `limit` would buy nothing — `readDecisions`
  // parses the whole file either way and only slices the tail — while costing exactly the
  // theses that matter most: a two-day-old position sits behind a busy day's ~100 hold
  // records, so a 200-record page rendered its thesis as "not recorded" while the link was
  // sitting in the journal. Read once per cycle, and not at all when nothing is linked.
  const needed = new Set(
    entries.map(s => s.entryDecisionId).filter((id): id is string => id != null),
  );
  const theses = new Map(
    needed.size === 0
      ? []
      : readDecisions().filter(r => needed.has(r.id)).map(r => [r.id, r] as const),
  );

  for (const snap of entries) {
    const entry = snap.entryPrice != null ? ` entry $${snap.entryPrice.toFixed(2)}` : '';
    const stop = snap.stopLevel != null ? ` SL $${snap.stopLevel.toFixed(2)}` : '';
    const tp = snap.takeProfitLevel != null ? ` TP $${snap.takeProfitLevel.toFixed(2)}` : '';

    const e = bySymbol.get(normalizeSymbol(snap.symbol));
    if (e) matched.add(e.symbol);
    const weight = e ? `  ${e.weightPct.toFixed(1)}%` : '';
    const sector = e ? `  ${e.sector ?? '(sector unknown)'}` : '';
    const age = snap.openedAt ? ageOf(snap.openedAt) : null;
    // A snapshot with no venue position is a leftover, and rendering it like a holding invites
    // an exit for something that is already gone. Only claimed when exposure actually answered.
    const orphan = exp && !e ? '  NO LIVE POSITION AT THE VENUE' : '';
    lines.push(`  ${snap.symbol.padEnd(8)}${entry}${stop}${tp}${weight}${sector}${age ? `  age ${age}` : ''}${orphan}`);

    // MFE/MAE from the same three fields `compute.ts` uses, so the numbers agree. A missing
    // baseline omits the clause rather than printing NaN.
    const parts: string[] = [];
    if (snap.entryPrice != null && snap.entryPrice > 0) {
      const mfe = snap.sessionHigh != null
        ? signed(((snap.sessionHigh - snap.entryPrice) / snap.entryPrice) * 100) : null;
      const mae = snap.sessionLow != null
        ? signed(((snap.sessionLow - snap.entryPrice) / snap.entryPrice) * 100) : null;
      if (mfe || mae) {
        parts.push(`MFE ${mfe ?? 'n/a'} / MAE ${mae ?? 'n/a'}`);
      }
    }
    const thesis = snap.entryDecisionId ? theses.get(snap.entryDecisionId) : undefined;
    parts.push(
      thesis ? `"${truncate(thesis.rationale, MAX_RATIONALE_CHARS)}"` : 'rationale not recorded',
    );
    lines.push(`          ${parts.join(' — ')}`);
  }

  // Counted at the VENUE when exposure answered, not from the snapshot map. The two can differ —
  // a leftover snapshot, or a holding opened before this system recorded baselines — and the
  // snapshot count is what produced "-2 slots remaining" for a book of six. The guard in
  // `enterPosition` counts broker positions, so this is also the number that will be enforced.
  const count = exp ? exp.positions.length : entries.length;
  const slotsLeft = Math.max(0, getPolicy().risk.maxPositions - count);
  lines.push(`${count} open position${count !== 1 ? 's' : ''}${exp ? ' at the venue' : ''} — ${slotsLeft} slot${slotsLeft !== 1 ? 's' : ''} remaining. Call get_positions for live qty and P&L.`);

  // A holding with no snapshot has no entry price and no stop recorded anywhere, so it renders
  // in no row above. Saying nothing would make it invisible to the one reader who could act.
  const unsnapshotted = exp?.positions.filter(p => !matched.has(p.symbol)).map(p => p.symbol) ?? [];
  if (unsnapshotted.length > 0) {
    lines.push(`Held at the venue with nothing recorded here — no entry price, no stop: ${unsnapshotted.join(', ')}.`);
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
  const shown = events
    .filter(e => e.severity !== 'info')
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
      `  ${r.at.slice(0, 16)} ${r.kind.toUpperCase().padEnd(8)} ${(r.symbol ?? '—').padEnd(6)}${qty}${pnl}${why} — ${r.rationale}`,
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
function buildLessons(): string {
  const all = readLessons();
  if (all.length === 0) return '';

  const shown = all.slice(-MAX_LESSONS);
  const lines = [`=== LESSONS (${shown.length}${all.length > shown.length ? ` of ${all.length}` : ''}) ===`];
  lines.push('Written by earlier cycles of this system. They are standing rules of thumb, not history — treat them as binding unless this cycle produces evidence against one, in which case write the correction with write_lesson.');
  for (const lesson of shown) {
    lines.push('');
    lines.push(lesson);
  }
  lines.push('=== END LESSONS ===');
  return lines.join('\n');
}

/**
 * Exported as a probe seam. `verify:policy` renders the system half of the prompt without a
 * daemon; this is the user half, and every block in it is prose the model will read as fact —
 * so it has to be readable without starting a trading loop to see it.
 */
export async function buildCycleContext(
  state: ReturnType<typeof getState>,
  pendingMessages: string[],
): Promise<string> {
  const lines: string[] = [`=== CYCLE: ${new Date().toISOString()} ===`];

  // First, before any of the standing bookkeeping: the events are the reason this cycle
  // exists at all, and a wake whose trigger is buried under the portfolio reads as a
  // routine periodic check.
  const eventCtx = buildMachineEvents();
  if (eventCtx) { lines.push(eventCtx); lines.push(''); }

  lines.push(
    `Start-of-day equity: ${
      state.startOfDayEquity > 0
        ? '$' + state.startOfDayEquity.toFixed(2)
        : 'unknown — call get_account to initialize'
    }`,
  );

  const portfolioCtx = await buildPortfolioContext(state.positionSnapshots);
  if (portfolioCtx) { lines.push(''); lines.push(portfolioCtx); }

  const historyCtx = buildDecisionHistory();
  if (historyCtx) { lines.push(''); lines.push(historyCtx); }

  const lessonsCtx = buildLessons();
  if (lessonsCtx) { lines.push(''); lines.push(lessonsCtx); }

  if (pendingMessages.length > 0) {
    lines.push('');
    lines.push('=== OPERATOR INSTRUCTIONS ===');
    pendingMessages.forEach(m => lines.push(`> ${m}`));
    lines.push('=== END OPERATOR INSTRUCTIONS ===');
    lines.push('Act on these instructions as part of this cycle.');
  }

  lines.push('');
  lines.push('If MACHINE EVENTS are present, deal with the critical and urgent ones before anything else. Otherwise start with get_market_status + get_account + get_positions. End with sleep().');

  return lines.join('\n');
}

