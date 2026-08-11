import { createModelProvider } from '../core/modelProvider';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { renderPolicy } from '../policy/render';
import { getPolicy } from '../policy/load';
import { getState } from '../state/state';
import { readDecisions } from '../journal/journal';
import { getPendingEvents, type Severity } from '../features/eventBus';
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
        content: [{ type: 'text', text: buildCycleContext(state, pendingMessages) }],
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
            logger.info(`[Orchestrator] Next cycle in ${minutes} min — ${block.input.reason}`);
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

function buildPortfolioContext(
  snapshots: Record<string, PositionSnapshot>,
  equity: number,
): string {
  const entries = Object.values(snapshots);
  if (entries.length === 0) return '';

  const lines = ['=== PORTFOLIO CONTEXT ==='];
  let totalValue = 0;

  for (const snap of entries) {
    totalValue += snap.qty * snap.lastPrice;
    lines.push(`  ${snap.symbol.padEnd(6)} ${snap.qty}sh @ $${snap.lastPrice.toFixed(2)}`);
  }

  const utilPct = equity > 0 ? Math.round((totalValue / equity) * 100) : 0;
  const slotsLeft = getPolicy().risk.maxPositions - entries.length;
  lines.push(`Deployed: ~$${totalValue.toFixed(0)} / $${equity.toFixed(0)} equity (${utilPct}%) — ${slotsLeft} slot${slotsLeft !== 1 ? 's' : ''} remaining`);
  lines.push('Avoid sector concentration — assess the sectors of open positions before adding a new entry.');
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

function buildCycleContext(
  state: ReturnType<typeof getState>,
  pendingMessages: string[],
): string {
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

  const portfolioCtx = buildPortfolioContext(state.positionSnapshots, state.startOfDayEquity);
  if (portfolioCtx) { lines.push(''); lines.push(portfolioCtx); }

  const historyCtx = buildDecisionHistory();
  if (historyCtx) { lines.push(''); lines.push(historyCtx); }

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

