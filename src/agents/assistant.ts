import { runtimeContract } from './runtimeContract';
import { ToolRegistry } from './toolRegistry';
import { runAgentLoop, compactMessages } from './agentLoop';
import { enqueueRequest, pendingRequests, updateRequest, getRequest, type AgentRequest } from '../core/requests';
import { getOpenActions } from '../core/actions';
import { getPolicyHash, getPolicySnapshot } from '../policy/load';
import { summarizeStrategy } from '../policy/summary';
import { agentContext } from '../core/agentContext';
import { updateTradingSettings, type TradingSettingsUpdate } from '../policy/mutate';
import { startResearch } from './researcher';
/**
 * Assistant Agent — the user-facing conversational layer.
 *
 * Maintains a persistent conversation with the operator across messages.
 * Has read access to all system state and can send instructions to the
 * trader (which wakes it if sleeping).
 *
 * The trader never talks to the user directly — that's this agent's job.
 */

import { readRecord, listRecords } from '../core/storage';
import { createModelProvider } from '../core/modelProvider';
import { config } from '../core/config';
import { getPolicy } from '../policy/load';
import { renderPolicy } from '../policy/render';
import { logger } from '../core/logger';
import { ui } from '../ui/ui';
import { getState } from '../state/state';
import { TRADER_TOOL_DEFINITIONS, executeTraderTool } from '../tools/traderTools';
import { ALPACA_DATA_TOOL_DEFINITIONS } from '../tools/alpacaDataTools';
import { RESEARCH_TOOL_DEFINITIONS } from '../tools/researchTools';
import { CHART_TOOL_DEFINITIONS, executeChartTool } from '../tools/chartTools';
import type { ChatMessage, ContentBlock, ToolDefinition } from '../core/types';

/**
 * Tools the assistant shares verbatim with the trader.
 *
 * Picked BY NAME out of `TRADER_TOOL_DEFINITIONS`, never restated. Every one of these is
 * executed by `executeTraderTool` — the assistant adds no behaviour to any of them — so a
 * second copy of the definition could differ only in its prose, and it did: the trader's
 * `get_exposure` carries an anti-fabrication warning ("a sector weight you did not read
 * from here is a fabricated one") that the copy here had silently dropped. One definition,
 * one description, one place to change it.
 */
const SHARED_WITH_TRADER = [
  'get_account',
  'get_requests',
  'get_lessons',
  'get_actions',
  'get_positions',
  'get_open_orders',
  'get_market_status',
  'get_pending_events',
  'get_journal',
  'get_scorecard',
  'get_benchmark',
  'get_price_stats',
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
 * next start loudly, rather than quietly leaving the assistant one capability short and
 * the operator wondering why it claims it cannot read the book.
 */
function sharedTools(): ToolDefinition[] {
  return SHARED_WITH_TRADER.map((name) => {
    const def = TRADER_TOOL_DEFINITIONS.find((t) => t.name === name);
    if (!def) {
      throw new Error(
        `Assistant expects trader tool "${name}", which is no longer in TRADER_TOOL_DEFINITIONS.`,
      );
    }
    return def;
  });
}

/** Read helpers and action/relay tools owned by the assistant. */
const ASSISTANT_OWN_TOOLS: ToolDefinition[] = [
  {
    name: 'get_strategy_settings',
    description: 'Read a concise explanation of the current saved account strategy: risk profile, risk per trade, annualized volatility target, minimum reward:risk, capital and concentration limits, daily entry halt, approvals, allowed symbols and entry rules. Includes a ready-to-use plain-language summary and consistently scaled percentages. Read this afresh whenever the operator asks about settings or proposes a change; do not use an older conversation or the shipped defaults. This is read-only and does not fetch market data or activate anything.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_state',
    description: 'Get internal system state: start-of-day equity, the watchlist, and the durable per-position baselines (entry, stop, target, session high/low).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_request_trace',
    description: "Read what an agent actually did for one request: who started it, the text the model wrote, and every tool call in order with its inputs and a short result. Take the requestId from an action or from get_requests. Use it to answer why an entry or exit happened — the action's reason is the model's own words, and this shows whether anything in the turn supports them.",
    input_schema: {
      type: 'object',
      properties: { requestId: { type: 'string', description: 'The request id, verbatim.' } },
      required: ['requestId'],
    },
  },
  {
    name: 'send_to_trader',
    description: 'Queue an operator instruction for the trader and return its durable request ID and actual status. Paused traders keep the request queued; busy traders handle it in a later cycle. Use get_requests and get_actions for outcomes.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Instruction for the trader.' },
      },
      required: ['message'],
    },
  },
  {
    name: 'research_symbol',
    description: 'Start full research on one stock in the research worker: business, news and SEC filings, trend, catalysts, portfolio fit and proposed entry/stop/target levels, ending in a saved buy/wait/skip or holding verdict. Returns immediately; the finished summary is posted to this chat automatically. It places no orders and runs even while trading is paused. A stock already being researched is not started twice.',
    input_schema: {
      type: 'object',
      properties: { symbol: { type: 'string', description: 'Ticker as written, e.g. "BRK.B".' } },
      required: ['symbol'],
    },
  },
  {
    name: 'get_policy_playbook',
    description: 'Read the rendered account playbook and platform execution contract. Use this to quote or explain strategy prose; use get_strategy_settings for a concise view of saved numeric settings and approval behavior. Platform constraints and numeric risk settings take precedence over conflicting playbook prose.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'update_trading_settings',
    description: 'Save changes to the account strategy settings: add/remove watchlist symbols or adjust position sizing, risk-profile controls, exposure limits or the ATR stop guide. Read get_strategy_settings first. Only call this when the operator has asked for the change (or confirmed a value you suggested). The change takes effect immediately, is recorded in the strategy change history, and goes through the same checks as the Strategy settings form; a rejected value returns ok:false with the reason and saves nothing. Approval/automation settings cannot be changed here.',
    input_schema: {
      type: 'object',
      properties: {
        addToWatchlist:      { type: 'array',  items: { type: 'string' }, description: 'Ticker symbols to add to the watchlist.' },
        removeFromWatchlist: { type: 'array',  items: { type: 'string' }, description: 'Ticker symbols to remove from the watchlist.' },
        setWatchlist:        { type: 'array',  items: { type: 'string' }, description: 'Replace the entire watchlist with these symbols.' },
        maxPositions:        { type: 'integer', minimum: 1,               description: 'Maximum number of open positions.' },
        positionSizePct:     { type: 'number',  minimum: 0,               description: 'Position size as a fraction of equity (e.g. 0.05 = 5%).' },
        stopLossAtrMult:     { type: 'number',  minimum: 0,               description: 'ATR multiple used to guide stop placement, not a fixed percentage loss or the enforced maximum stop distance.' },
        maxDailyLossPct:     { type: 'number',  minimum: 0,               description: 'Daily loss limit as a fraction of equity (e.g. 0.03 = 3%).' },
        maxGrossExposurePct: { type: 'number',  minimum: 0,               description: 'Gross exposure ceiling across the whole book, as a fraction of equity (e.g. 1.0 = 100%, fully deployed).' },
        riskPerTradePct:     { type: 'number', minimum: 0.01, maximum: 2, description: 'Planned loss at the stop as percentage points of equity: 0.5 means 0.5%. This is different from capital invested.' },
        targetVolatilityPct:{ type: 'number', minimum: 1, maximum: 50, description: 'Estimated annualized portfolio volatility target in percentage points: 12 means 12% per year.' },
        minRewardRisk:      { type: 'number', minimum: 0.1, maximum: 20, description: 'Minimum planned reward:risk ratio: 2 means 2:1. Not a promised return.' },
        maxSingleWeightPct: { type: 'number', minimum: 0, maximum: 100, description: 'Single-name concentration threshold in percentage points: 10 means 10% of equity.' },
        maxSectorWeightPct: { type: 'number', minimum: 0, maximum: 100, description: 'Sector concentration threshold in percentage points: 30 means 30% of equity.' },
      },
      required: [],
    },
  },
];

/** Tools that change something. Their full inputs and results are what the trace is for. */
const ACTION_TOOLS = new Set(['update_trading_settings', 'execute_entry', 'execute_exit', 'annotate_position', 'ack_event', 'write_lesson', 'send_to_trader', 'research_symbol', 'request_research', 'sleep']);

/**
 * The stored turn, flattened to what was said and done. The opening context message is left
 * out (it is the whole cycle snapshot); the request text stands in for it.
 */
/**
 * The chat so far: each chat turn starts from the one before it, so the latest earlier
 * turn in agentTurn.jsonl already holds the whole conversation.
 */
function previousChat(currentId: string): ChatMessage[] {
  for (const { id } of listRecords<AgentRequest>('requests', { where: c => c.role === 'assistant' && c.id !== currentId, desc: true })) {
    const turn = readRecord<{ messages: ChatMessage[] }>('transcripts', id);
    if (turn?.messages.length) return turn.messages;
  }
  return [];
}

function requestTrace(requestId: string): string {
  const command = getRequest(requestId);
  if (!command) return JSON.stringify({ ok: false, error: `No request with id ${requestId}. Read get_requests or an action's requestId.` });
  const clip = (s: unknown, n: number) => { const t = typeof s === 'string' ? s : JSON.stringify(s); return t.length > n ? t.slice(0, n) + '…' : t; };
  const steps: Record<string, unknown>[] = [];
  const turn = readRecord<{ messages: ChatMessage[] }>('transcripts', requestId);
  if (turn) {
    const results = new Map<string, string>();
    for (const m of turn.messages) for (const b of m.content) if (b.type === 'tool_result') results.set(b.tool_use_id, b.content);
    for (const m of turn.messages.slice(1)) {
      if (m.role !== 'assistant') continue;
      for (const b of m.content) {
        if (b.type === 'text' && b.text.trim()) steps.push({ wrote: clip(b.text, 1500) });
        if (b.type === 'tool_use') {
          const full = ACTION_TOOLS.has(b.name);
          steps.push({ call: b.name, input: full ? b.input : clip(b.input, 200), result: clip(results.get(b.id) ?? 'no result recorded', full ? 600 : 160) });
        }
      }
    }
  }
  const wroteText = steps.some(s => 'wrote' in s);
  return JSON.stringify({
    command: { id: command.id, agent: command.role, startedBy: command.actorId === 'system' ? 'scheduler (no operator instruction)' : command.actorId,
      request: command.text, status: command.status, result: command.result, actionIds: command.actionIds },
    ...(wroteText ? {} : { note: 'The model wrote no text in this request; the only reasons it gave are the tool inputs below.' }),
    steps: steps.slice(-60),
  });
}

const ASSISTANT_TOOLS: ToolDefinition[] = [
  ...sharedTools(),
  ...ASSISTANT_OWN_TOOLS,
  ...ALPACA_DATA_TOOL_DEFINITIONS,
  ...RESEARCH_TOOL_DEFINITIONS,
  ...CHART_TOOL_DEFINITIONS,
];

const CHART_TOOL_NAMES = new Set(CHART_TOOL_DEFINITIONS.map((t) => t.name));

/**
 * The prompt lists tool NAMES ONLY, generated from the array above.
 *
 * The API already sends every description alongside the tools, so restating them here was
 * a third copy of the same prose — and the one nothing could typecheck. Behavioural
 * guidance that is not in a description (when to relay versus when to change policy) stays
 * below; per-tool detail belongs in the tool.
 */
const SYSTEM_PROMPT = `You are AutoTrade's account assistant.
Answer questions using the account tools and cite the recorded reasons and outcomes.
When the operator asks you to research or assess a stock, call research_symbol; do not relay research to the trader. Say the research has started and that its summary will appear in this chat when it finishes; do not predict its verdict.
Relay an instruction only when the operator asks the trader to act. send_to_trader returns a durable request ID and queue status. Report that status accurately; use get_requests and get_actions for the outcome.
You cannot place trades, approve actions or adopt holdings. The operator adopts a holding themselves: in the terminal with /adopt SYMBOL STOP [TARGET], in the browser dashboard with Adopt holding. You can save strategy settings changes with update_trading_settings, except approval/automation settings.
For pause/resume and approvals, direct the operator to the account controls.
A one-off instruction goes to the trader. A lasting settings change is saved with update_trading_settings.
To explain why a position was entered or exited, read get_actions for that symbol (includeDecided), then get_request_trace with the action's requestId: say who started the request, the stated reason, and whether the turn shows evidence for it. If the recorded reason contradicts the action — a hold sentence on a sell, "operator-directed" when the scheduler started it, or no reason at all — say so plainly; do not present it as a deliberate decision.
get_state shows pause, account and outstanding actions. get_journal explains decisions, newest kept when trimmed; get_scorecard reports closed-trade statistics; get_benchmark supplies verified account performance. Raw equity growth is not investment return.
Read get_strategy_settings afresh before describing current settings or suggesting a change. Its summary is the presentation baseline; use its correctly scaled values, not remembered defaults or old conversation results.
For a general settings question, lead with the saved profile, then group risk controls, investment limits and approvals into short labeled lines or bullets. Include the allowed symbols in a full overview. Answer a narrow question using just the relevant settings. Avoid raw JSON, YAML keys, revision hashes and Markdown tables; the account chat displays plain text.
Explain risk per trade as planned loss at the stop and position size as money invested. Name volatility as an annualized estimate, reward:risk as planned upside versus downside, and blank controls as not configured. A daily loss threshold halts new entries; it does not guarantee losses cannot exceed it. Distinguish alerts from entry limits and saved settings from actual holdings or trading status.
Settings questions do not wake the trader. When the operator asks to change a setting, save it with update_trading_settings and report the before and after values from its result. When you are only suggesting values, label them as suggestions and ask before saving. Never claim a change was saved unless the tool returned ok:true; if it returned errors, say what was rejected.
Read get_policy_playbook when quoting or explaining account strategy prose. Lessons are advisory observations and must not override strategy or platform behavior.
Use chart tools when the operator asks to see history or a comparison. Their results state whether a comparison is available.
Give a final answer after reading tool results. If a tool fails, state its recorded error without inventing a cause. Do not claim a queued action filled or that a paused trader started immediately.
Keep answers concise. Tools available: ${ASSISTANT_TOOLS.map(t => t.name).join(', ')}.`;

export class AssistantAgent {
  private readonly provider = createModelProvider(config.ai);
  private active: Promise<void> | null = null;
  private controller = new AbortController();
  private stopped = false;
  private readonly registry = new ToolRegistry(ASSISTANT_TOOLS, (name, input) => this.dispatchTool(name, input));

  constructor(private readonly wake: (msg: string) => unknown) {}

  handleMessage(userText: string, actorId = 'operator'): AgentRequest {
    if (this.stopped) throw new Error('The service is stopping');
    const command = enqueueRequest('assistant', userText, actorId);
    this.resumeQueue();
    return command;
  }

  resumeQueue(): void {
    if (!this.active && !this.stopped) {
      this.active = this.drain().finally(() => { this.active = null; });
    }
  }
  async stop(): Promise<void> {
    this.stopped = true; this.controller.abort();
    await this.active;
  }
  private async drain(): Promise<void> {
    while (!this.stopped) {
      const command = pendingRequests('assistant')[0];
      if (!command) return;
      updateRequest(command.id, { status: 'running' });
      ui.setAssistantActivity({ state: 'thinking' });
      try {
        const turn = await runAgentLoop({
          context: { role: 'assistant', requestId: command.id, actorId: command.actorId },
          provider: this.provider, registry: this.registry, systemPrompt: runtimeContract() + "\n\n" + SYSTEM_PROMPT,
          messages: async () => [...compactMessages(previousChat(command.id), 24000),
            { role: 'user', content: [{ type: 'text', text: command.text }] }],
          maxRounds: config.ai.maxToolRounds, maxTokens: config.ai.maxTokensPerTurn, signal: this.controller.signal,
        });
        const result = turn.error ?? (turn.text || 'Request processed. Check linked actions for execution status.');
        updateRequest(command.id, { status: turn.status, result });
        if (turn.status === 'interrupted') return;
      } catch (err: any) {
        updateRequest(command.id, { status: 'failed', result: err.message });
      } finally { ui.setAssistantActivity({ state: 'idle' }); }
    }
  }
  pushAlert(message: string): void { ui.alert(message); }
  private executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    return this.registry.execute(name, input);
  }

  private async dispatchTool(name: string, input: Record<string, unknown>): Promise<string> {
    if (name === 'get_strategy_settings') {
      const snapshot = getPolicySnapshot();
      return JSON.stringify(summarizeStrategy(snapshot.policy, snapshot.hash));
    }
    if (name === 'get_state') {
      const state = getState();
      return JSON.stringify({
        paused: state.paused,
        accountId: state.accountId,
        strategyHash: getPolicyHash(),
        actions: getOpenActions(),
        startOfDayEquity: state.startOfDayEquity,
        lastResetDate: state.lastResetDate,
        watchlist: getPolicy().strategy.watchlist,
        positionSnapshots: state.positionSnapshots,
      });
    }

    if (name === 'get_policy_playbook') {
      try {
        return JSON.stringify({ runtimeContract: runtimeContract(), playbook: renderPolicy() });
      } catch (err: any) {
        return JSON.stringify({ error: `PLAYBOOK.md failed to render: ${err.message}` });
      }
    }

    if (name === 'get_request_trace') return requestTrace(String(input.requestId ?? ''));

    if (name === 'research_symbol') {
      const request = startResearch(String(input.symbol ?? ''), agentContext.getStore()?.actorId ?? 'operator', { replyToChat: true });
      return JSON.stringify({ ok: true, requestId: request.id, status: request.status, symbol: request.symbol,
        note: 'The summary is posted to this chat when the research finishes. Use get_requests for its status.' });
    }

    if (name === 'send_to_trader') {
      const message = input.message as string;
      return JSON.stringify({ ok: true, receipt: this.wake(message) });
    }

    if (name === 'update_trading_settings') {
      const result = updateTradingSettings(input as TradingSettingsUpdate, `assistant:${agentContext.getStore()?.actorId ?? 'operator'}`);
      if (!result.ok) return JSON.stringify(result);
      const snapshot = getPolicySnapshot();
      return JSON.stringify({ ...result, saved: summarizeStrategy(snapshot.policy, snapshot.hash) });
    }

    if (CHART_TOOL_NAMES.has(name)) {
      return executeChartTool(name, input);
    }

    return executeTraderTool(name, input);
  }
}
