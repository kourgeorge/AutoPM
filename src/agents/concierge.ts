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
import { executeTraderTool } from '../tools/traderTools';
import { ALPACA_DATA_TOOL_DEFINITIONS } from '../tools/alpacaDataTools';
import { RESEARCH_TOOL_DEFINITIONS } from '../tools/researchTools';
import type { ChatMessage, ContentBlock, ToolDefinition } from '../core/types';

const SYSTEM_PROMPT = `You are the operator concierge for an autonomous momentum trading system called AutoTrade.

YOUR ROLE
- Be the primary interface between the human operator and the trading system
- Answer questions about positions, account status, market conditions, and trading activity
- Relay operator instructions to the trader when requested
- Proactively inform the operator about alerts pushed by the system
- Be conversational, concise, and helpful

WHAT YOU HAVE ACCESS TO
- get_account: equity, cash, buying power, daily P&L
- get_positions: all open positions with unrealized P&L
- get_market_status: market open/closed, time to next open/close
- get_state: start-of-day equity, the watchlist, and the durable per-position baselines
- get_pending_events: machine events that have fired and the trader has not yet answered
- get_journal(symbol?, limit?): every past decision — entries, exits, holds, guard vetoes, venue rejections — with its rationale
- send_to_trader(message): send an instruction to the trader and wake it
- get_macro_regime: current macro regime (expansion, late_cycle, recession, recovery)
- get_position_size(symbol, price, atr): volatility-scaled share count for a symbol
- get_signals(symbol): the five entry signal scores plus ATR and last close
- get_correlation(symbol): max pairwise correlation with current holdings
- get_exposure: full book shape — weights, sectors, concentration, held-vs-held correlations
- get_stock_bars(symbols, timeframe?, limit?): historical OHLCV bars
- get_stock_snapshot(symbols): latest quote, trade, and bars in one call
- get_stock_latest_quote(symbols): current bid/ask
- get_most_active_stocks(by?, top?): most active stocks by volume or trade count
- get_market_movers(top?): top gainers and losers for the session
- get_news(symbols?, limit?): recent news articles via Alpaca
- get_portfolio_history(period?, timeframe?): account equity and P&L over a historical period
- web_search(query): general web search for news or analysis not covered by the above

WHEN TO USE send_to_trader
- Operator wants to change trading behavior ("stop trading", "exit all positions", "research TSLA")
- Operator wants the trader to do something specific on its next cycle
- Always tell the operator what you sent and that the trader has been woken

TONE
- Friendly but professional
- Short answers unless the operator wants detail
- If you don't know something (e.g. why a specific trade was made, or why one wasn't), check get_journal first
- You do NOT place trades directly — you relay to the trader`;

const CONCIERGE_TOOLS: ToolDefinition[] = [
  {
    name: 'get_account',
    description: 'Get account equity, cash, buying power, and daily P&L.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_positions',
    description: 'Get all currently open positions.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_market_status',
    description: 'Get current market status: open/closed, ET time, minutes to next open/close.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_state',
    description: 'Get internal system state: start-of-day equity, the watchlist, and the durable per-position baselines (entry, stop, target, session high/low).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_pending_events',
    description: 'Get every machine event that has fired and not been acked by the trader — what the system has noticed and is waiting on.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_journal',
    description: 'Read past decisions, oldest first: entries, exits, holds, guard vetoes and venue rejections, each with its rationale and the numbers it intended.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Optional — filter to one symbol.' },
        limit: { type: 'integer', description: 'Most recent N records (default 20).', minimum: 1, maximum: 200 },
      },
      required: [],
    },
  },
  {
    name: 'send_to_trader',
    description: 'Send an instruction or message to the trader. It will wake up and process it on the next cycle.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Instruction for the trader.' },
      },
      required: ['message'],
    },
  },
  // ── Informational tools (read-only, same as trader) ──────────────────────────
  {
    name: 'get_macro_regime',
    description: 'Classify the current macro regime (expansion, late_cycle, recession, recovery) based on GDP growth, unemployment, CPI, yield curve, and VIX from FRED. Cached for 6h.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_position_size',
    description: 'Compute a volatility-scaled position size for a symbol. Uses inverse-ATR sizing so high-volatility names get fewer shares.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol.' },
        price:  { type: 'number', description: 'Current/expected entry price.' },
        atr:    { type: 'number', description: 'Current ATR for the symbol.' },
      },
      required: ['symbol', 'price', 'atr'],
    },
  },
  {
    name: 'get_signals',
    description: 'Compute the five entry signals — EMA Momentum, Trend Strength, Volume, Breakout, MACD — for any symbol, each scored -1 to +1, plus ATR and the last close.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol to score.' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_correlation',
    description: 'Check how correlated a candidate symbol is with current holdings. Returns the max pairwise correlation and a sizing recommendation.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Candidate ticker to check against existing positions.' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_exposure',
    description: 'Full book shape: per-position weight, sector, gross deployed, cash, largest single-name and sector weights, Herfindahl concentration index, and held-vs-held correlation pairs.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  ...ALPACA_DATA_TOOL_DEFINITIONS,
  ...RESEARCH_TOOL_DEFINITIONS,
  // ── Policy mutation ───────────────────────────────────────────────────────────
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
        stopLossAtrMult:     { type: 'number',  minimum: 0,               description: 'Stop distance = entry − stopLossAtrMult × ATR.' },
        takeProfitAtrMult:   { type: 'number',  minimum: 0,               description: 'Target = entry + takeProfitAtrMult × ATR.' },
        maxDailyLossPct:     { type: 'number',  minimum: 0,               description: 'Daily loss limit as a fraction of equity (e.g. 0.03 = 3%).' },
      },
      required: [],
    },
  },
];

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
      ui.setStatus('concierge thinking…');
      try {
        this.history.push({ role: 'user', content: [{ type: 'text', text: msg }] });
        await this.runTurn();
      } catch (err: any) {
        logger.error(`[Concierge] Error: ${err.message}`);
        ui.reply('Sorry, I ran into an error. Please try again.');
      } finally {
        this.busy = false;
        ui.setStatus('ready');
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
        logger.tool('Concierge', block.name, result);
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
