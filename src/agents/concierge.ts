/**
 * Concierge Agent — the user-facing conversational layer.
 *
 * Maintains a persistent conversation with the operator across messages.
 * Has read access to all system state and can send instructions to the
 * trader (which wakes it if sleeping).
 *
 * The trader never talks to the user directly — that's this agent's job.
 */

import { createModelProvider } from '../core/modelProvider';
import { config } from '../core/config';
import { getPolicy } from '../policy/load';
import { mutatePolicy } from '../policy/mutate';
import { logger } from '../core/logger';
import { ui } from '../ui/ui';
import { getState } from '../state/state';
import { TRADER_TOOL_DEFINITIONS, executeTraderTool } from '../tools/traderTools';
import { ALPACA_DATA_TOOL_DEFINITIONS } from '../tools/alpacaDataTools';
import { RESEARCH_TOOL_DEFINITIONS } from '../tools/researchTools';
import type { ChatMessage, ContentBlock, ToolDefinition } from '../core/types';

/**
 * Tools the concierge shares verbatim with the trader.
 *
 * Picked BY NAME out of `TRADER_TOOL_DEFINITIONS`, never restated. Every one of these is
 * executed by `executeTraderTool` — the concierge adds no behaviour to any of them — so a
 * second copy of the definition could differ only in its prose, and it did: the trader's
 * `get_exposure` carries an anti-fabrication warning ("a sector weight you did not read
 * from here is a fabricated one") that the copy here had silently dropped. One definition,
 * one description, one place to change it.
 */
const SHARED_WITH_TRADER = [
  'get_account',
  'get_positions',
  'get_open_orders',
  'get_market_status',
  'get_pending_events',
  'get_journal',
  'get_scorecard',
  'get_benchmark',
  'get_macro_regime',
  'get_signals',
  'get_watchlist_scan',
  'get_correlation',
  'get_exposure',
  'get_calendar',
  'get_fundamentals',
] as const;

/**
 * Resolve the shared names against the trader's array.
 *
 * Throws at MODULE LOAD, not at call time: a trader tool that gets renamed must fail the
 * next start loudly, rather than quietly leaving the concierge one capability short and
 * the operator wondering why it claims it cannot read the book.
 */
function sharedTools(): ToolDefinition[] {
  return SHARED_WITH_TRADER.map((name) => {
    const def = TRADER_TOOL_DEFINITIONS.find((t) => t.name === name);
    if (!def) {
      throw new Error(
        `Concierge expects trader tool "${name}", which is no longer in TRADER_TOOL_DEFINITIONS.`,
      );
    }
    return def;
  });
}

/** The three the concierge actually owns — nothing else here is unique to it. */
const CONCIERGE_OWN_TOOLS: ToolDefinition[] = [
  {
    name: 'get_state',
    description: 'Get internal system state: start-of-day equity, the watchlist, and the durable per-position baselines (entry, stop, target, session high/low).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'send_to_trader',
    description: 'Send an instruction or message to the trader. Calling this tool IMMEDIATELY interrupts the trader\'s sleep and starts a new cycle — do not paraphrase this as "next cycle" or "when it wakes up". Use this any time the operator wants the trader to act now.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Instruction for the trader.' },
      },
      required: ['message'],
    },
  },
  {
    name: 'update_policy',
    description: 'Persistently change trading behaviour: add/remove watchlist symbols, adjust position sizing, risk limits, or stop/target multipliers. Changes are validated and hot-reloaded — the trader sees them on its next cycle. Immutable safety ceilings are always enforced.',
    input_schema: {
      type: 'object',
      properties: {
        addToWatchlist:      { type: 'array',  items: { type: 'string' }, description: 'Ticker symbols to add to the watchlist.' },
        removeFromWatchlist: { type: 'array',  items: { type: 'string' }, description: 'Ticker symbols to remove from the watchlist.' },
        setWatchlist:        { type: 'array',  items: { type: 'string' }, description: 'Replace the entire watchlist with these symbols.' },
        maxPositions:        { type: 'integer', minimum: 1,               description: 'Maximum number of open positions.' },
        positionSizePct:     { type: 'number',  minimum: 0,               description: 'Position size as a fraction of equity (e.g. 0.05 = 5%).' },
        stopLossAtrMult:     { type: 'number',  minimum: 0,               description: 'Stop distance = entry \u2212 stopLossAtrMult \u00d7 ATR.' },
        takeProfitAtrMult:   { type: 'number',  minimum: 0,               description: 'Target = entry + takeProfitAtrMult \u00d7 ATR.' },
        maxDailyLossPct:     { type: 'number',  minimum: 0,               description: 'Daily loss limit as a fraction of equity (e.g. 0.03 = 3%).' },
      },
      required: [],
    },
  },
];

const CONCIERGE_TOOLS: ToolDefinition[] = [
  ...sharedTools(),
  ...CONCIERGE_OWN_TOOLS,
  ...ALPACA_DATA_TOOL_DEFINITIONS,
  ...RESEARCH_TOOL_DEFINITIONS,
];

/**
 * The prompt lists tool NAMES ONLY, generated from the array above.
 *
 * The API already sends every description alongside the tools, so restating them here was
 * a third copy of the same prose — and the one nothing could typecheck. Behavioural
 * guidance that is not in a description (when to relay versus when to change policy) stays
 * below; per-tool detail belongs in the tool.
 */
const SYSTEM_PROMPT = `You are the operator concierge for an autonomous momentum trading system called AutoTrade.

YOUR ROLE
- Be the primary interface between the human operator and the trading system
- Answer questions about positions, account status, market conditions, and trading activity
- Relay operator instructions to the trader when requested
- Proactively inform the operator about alerts pushed by the system
- Be conversational, concise, and helpful

YOUR TOOLS
${CONCIERGE_TOOLS.map((t) => t.name).join(', ')}

Read the description on each before using it. You have no source of a number beyond these —
a figure you did not read out of a tool result is one you invented.

WHEN TO USE send_to_trader
- Operator wants to change trading behavior ("stop trading", "exit all positions", "research TSLA")
- Operator wants the trader to act or wake up NOW — calling send_to_trader immediately interrupts the sleep timer
- Always call the tool, never just say you did — if you don't call it, the trader is NOT woken
- After calling, tell the operator: "Woken — it will run a cycle now and then sleep again." Do NOT say "awake and ready" — the cycle takes ~1 min and then the trader goes back to sleep automatically
- A one-off instruction goes to the trader; a lasting rule change ("only trade these five names",
  "cut size to 3%") belongs in update_policy, or it dies with that cycle

TONE
- Friendly but professional
- Short answers unless the operator wants detail
- If you don't know WHY something was done (a trade made, or not made), check get_journal first
- If you don't know HOW IT TURNED OUT (win rate, expectancy, whether stops held), call get_scorecard.
  The journal records decisions and never joins an entry to its exit, so it cannot answer this — and
  a win rate assembled by hand out of decisions is a fabricated one
- If the operator asks how we are DOING (up or down, better or worse than the market), that is
  get_benchmark, not get_scorecard: the scorecard's figures are absolute and closed-trade only, so
  they can read well while the account trailed SPY. Quote both — the benchmark number, then the
  scorecard as the explanation for it
- You do NOT place trades directly — you relay to the trader`;

export class ConciergeAgent {
  private readonly provider = createModelProvider(config.ai);
  private readonly history: ChatMessage[] = [];
  private busy = false;
  private readonly queue: string[] = [];

  constructor(private readonly wake: (msg: string) => void) {}

  async handleMessage(userText: string): Promise<void> {
    this.queue.push(userText);
    if (this.busy) return; // will be drained when current turn finishes
    await this.drain();
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const msg = this.queue.shift()!;
      this.busy = true;
      // Its OWN lane. This used to be `ui.setStatus`, which the trader also wrote to — so
      // answering a question erased the trader's sleep countdown, and 'ready' below claimed the
      // trader was idle when it was mid-cycle.
      ui.setConciergeActivity({ state: 'thinking' });
      try {
        this.history.push({ role: 'user', content: [{ type: 'text', text: msg }] });
        await this.runTurn();
      } catch (err: any) {
        logger.error(`[Concierge] Error: ${err.message}`);
        ui.reply('Sorry, I ran into an error. Please try again.');
      } finally {
        this.busy = false;
        ui.setConciergeActivity({ state: 'idle' });
      }
    }
  }

  /** Called by AlertWatcher to surface alerts to the user without a user prompt. */
  pushAlert(message: string): void {
    ui.alert(message);
    // Also inject into conversation history so the concierge has context
    this.history.push({
      role: 'user',
      content: [{ type: 'text', text: `[SYSTEM ALERT] ${message}` }],
    });
    this.history.push({
      role: 'assistant',
      content: [{ type: 'text', text: `Alert: ${message}` }],
    });
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async runTurn(): Promise<void> {
    for (let round = 0; round < 8; round++) {
      const response = await this.provider.chat({
        systemPrompt: SYSTEM_PROMPT,
        messages: this.history,
        tools: CONCIERGE_TOOLS,
        maxTokens: 1024,
      });

      this.history.push({ role: 'assistant', content: response.content });

      for (const block of response.content) {
        if (block.type === 'text' && block.text.trim()) {
          ui.reply(block.text.trim());
        }
      }

      if (response.stopReason !== 'tool_use') break;

      const toolBlocks = response.content.filter(
        (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      );

      const toolResults: ContentBlock[] = [];
      for (const block of toolBlocks) {
        const result = await this.executeTool(block.name, block.input as Record<string, unknown>);
        logger.tool('Concierge', block.name, result, block.input);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }

      this.history.push({ role: 'user', content: toolResults });
    }
  }

  private async executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    if (name === 'get_state') {
      const state = getState();
      return JSON.stringify({
        startOfDayEquity: state.startOfDayEquity,
        lastResetDate: state.lastResetDate,
        watchlist: getPolicy().strategy.watchlist,
        positionSnapshots: state.positionSnapshots,
      });
    }

    if (name === 'send_to_trader') {
      const message = input.message as string;
      this.wake(message);
      return JSON.stringify({ ok: true, sent: message });
    }

    if (name === 'update_policy') {
      return JSON.stringify(mutatePolicy(input as any));
    }

    return executeTraderTool(name, input);
  }
}
