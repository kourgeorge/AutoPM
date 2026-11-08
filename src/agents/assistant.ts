import { runtimeContract } from './runtimeContract';
import { ToolRegistry, pickTools } from './toolRegistry';
import { runAgentLoop, compactMessages, readTrajectory } from './agentLoop';
import { enqueueRequest, pendingRequests, updateRequest, getRequest, type AgentRequest } from '../core/requests';
import { pendingOrders } from '../core/orders';
import { getPolicyHash, getPolicySnapshot } from '../policy/load';
import { summarizeStrategy } from '../policy/summary';
import { updateTradingSettings, type TradingSettingsUpdate } from '../policy/mutate';
import { appEndpoints, readAppEndpoint } from '../server/api';
import { adoptHolding } from '../strategy/adopt';
import { confirmProtection, clearUnplacedProtection } from '../strategy/protectionIntent';
import { sweepOrders } from '../strategy/orderExecutor';
import { serviceStatus } from '../server/status';
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
import { createLiveModelProvider } from '../core/modelProvider';
import { config } from '../core/config';
import { getPolicy } from '../policy/load';
import { renderPolicy } from '../policy/render';
import { logger } from '../core/logger';
import { ui } from '../ui/ui';
import { getState, updateState } from '../state/state';
import { agentContext } from '../core/agentContext';
import { TRADER_TOOL_DEFINITIONS, executeTraderTool } from '../tools/traderTools';
import { toolKind } from '../tools/toolKinds';
import { CHART_TOOL_DEFINITIONS, executeChartTool } from '../tools/chartTools';
import type { ChatMessage, ContentBlock, ToolDefinition } from '../core/types';

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
    description: "Read what an agent actually did for one request: who started it, the text the model wrote, and every tool call in order with its inputs and a short result. Take the requestId from an order or from get_requests. Use it to answer why an entry or exit happened — the action's reason is the model's own words, and this shows whether anything in the turn supports them.",
    input_schema: {
      type: 'object',
      properties: { requestId: { type: 'string', description: 'The request id, verbatim.' } },
      required: ['requestId'],
    },
  },
  {
    name: 'get_app_endpoints',
    description: "List every read-only page of AutoTrade's own engine API — the same data the dashboard shows (AI model usage and token counts, service health, broker book, feed, saved prompts, agent requests, and more) — with what each returns. Read this when no other tool covers what the operator asks about the app itself.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_app',
    description: "Read one engine API page in-process and return its JSON exactly as the dashboard gets it. Pass the path with any query string, e.g. /api/llm-usage?days=7 or /api/llm-usage/day?day=2026-10-20. Read-only: only GET pages; nothing is changed. Take paths from get_app_endpoints.",
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path starting with /api/, with an optional query string.' } },
      required: ['path'],
    },
  },
  {
    name: 'send_to_trader',
    description: 'Send the operator\'s request to the trader and return its durable request ID and actual status. The trader handles it as a direct turn (not a full portfolio review) and its reply is posted to this chat when it finishes. Paused traders keep the request queued; a busy trader takes it after its current turn.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: "The operator's request for the trader, as close to their own words as possible. Do not expand it into a broader task." },
      },
      required: ['message'],
    },
  },
  {
    name: 'adopt_holding',
    description: "Hand an existing broker holding the app does not manage yet to the app, with a stop and optional target. The app then places the broker protection itself on its next protection pass. Same as Adopt holding on the dashboard. Use only when the operator asked for it and gave or agreed the stop.",
    input_schema: { type: 'object', properties: {
      symbol: { type: 'string' },
      stop: { type: 'number', description: 'Stop price, whole cents, below the current price.' },
      target: { type: 'number', description: 'Optional take-profit price, above the stop.' },
    }, required: ['symbol', 'stop'] },
  },
  {
    name: 'rearm_protection',
    description: "Clear an uncertain protection request for a managed holding, after checking the broker shows no open order for it, so the app places a fresh stop on its next pass. Refused while any broker order rests for the symbol. Same as Re-arm on the dashboard.",
    input_schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  },
  {
    name: 'confirm_protection',
    description: "Link a stop (and optional target) that already rests at the broker to a managed holding, after an interrupted protection request. The broker order must match the intended price and the held quantity. Same as Confirm protection on the dashboard.",
    input_schema: { type: 'object', properties: {
      symbol: { type: 'string' }, stopOrderId: { type: 'string' }, targetOrderId: { type: 'string' },
    }, required: ['symbol', 'stopOrderId'] },
  },
  {
    name: 'reconcile_orders',
    description: "Re-check every unfinished order against the broker now (the app also does this every few seconds) and return the service health: issues, unresolved orders, protection requests and unprotected holdings.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_trading_paused',
    description: "Pause or resume trading. Paused: the trader makes no scheduled reviews and none of its own orders are sent; what the operator asks for — your own orders and requests relayed to the trader — still runs. Orders already at the broker stay, and protection checks continue. Use only when the operator asked.",
    input_schema: { type: 'object', properties: { paused: { type: 'boolean' } }, required: ['paused'] },
  },
  {
    name: 'get_policy_playbook',
    description: 'Read the trader\'s full prompt: the platform execution contract, the app\'s built-in trader instructions, the user\'s own playbook (their preferences, possibly empty) and the active settings. Use this to quote or explain strategy prose; use get_strategy_settings for a concise view of saved numeric settings and approval behavior. Platform constraints and numeric risk settings take precedence over conflicting playbook prose.',
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
        targetInvestedPct:  { type: 'number', minimum: 0, maximum: 150, description: 'Share of equity the trader aims to keep invested, in percentage points: 80 means 80%. Must not exceed the gross exposure limit.' },
        minInvestedPct:     { type: 'number', minimum: 0, maximum: 150, description: 'Investment floor in percentage points: below it, holding cash needs a stated reason for each strong candidate. Must not exceed the target.' },
        maxEntriesPerDay:   { type: ['integer', 'null'], minimum: 1, maximum: 50, description: 'Most new positions the trader may open per trading day. null turns the cap off.' },
        lossCooldownHours:  { type: ['number', 'null'], minimum: 0, maximum: 720, description: 'Hours after a losing trade closes before the same symbol may be bought again. null turns it off.' },
        trailingStopAtrMult:{ type: ['number', 'null'], minimum: 0.5, maximum: 10, description: 'Trailing stop distance in ATR multiples below the highest price since entry; the machine raises stops to it automatically and never lowers them. null turns it off.' },
      },
      required: [],
    },
  },
];


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
    const turn = readTrajectory(id);
    if (turn?.messages.length) return turn.messages;
  }
  return [];
}

function requestTrace(requestId: string): string {
  const command = getRequest(requestId);
  if (!command) return JSON.stringify({ ok: false, error: `No request with id ${requestId}. Read get_requests or an order's requestId.` });
  const clip = (s: unknown, n: number) => { const t = typeof s === 'string' ? s : JSON.stringify(s); return t.length > n ? t.slice(0, n) + '…' : t; };
  const steps: Record<string, unknown>[] = [];
  const turn = readTrajectory(requestId);
  if (turn) {
    const results = new Map<string, string>();
    for (const m of turn.messages) for (const b of m.content) if (b.type === 'tool_result') results.set(b.tool_use_id, b.content);
    for (const m of turn.messages.slice(1)) {
      if (m.role !== 'assistant') continue;
      for (const b of m.content) {
        if (b.type === 'text' && b.text.trim()) steps.push({ wrote: clip(b.text, 1500) });
        if (b.type === 'tool_use') {
          // Tools that change something: their full inputs and results are what the trace is for.
          const kind = toolKind(b.name), full = kind !== null && kind !== 'read';
          steps.push({ call: b.name, input: full ? b.input : clip(b.input, 200), result: clip(results.get(b.id) ?? 'no result recorded', full ? 600 : 160) });
        }
      }
    }
  }
  const wroteText = steps.some(s => 'wrote' in s);
  return JSON.stringify({
    command: { id: command.id, agent: command.role, startedBy: command.actorId === 'system' ? 'scheduler (no operator instruction)' : command.actorId,
      request: command.text, status: command.status, result: command.result, orderIds: command.orderIds },
    ...(wroteText ? {} : { note: 'The model wrote no text in this request; the only reasons it gave are the tool inputs below.' }),
    steps: steps.slice(-60),
  });
}

/**
 * The assistant's own tools. Tools it shares with the trader are picked by name from
 * `TRADER_TOOL_DEFINITIONS`, never restated: one definition, one description. Every shared
 * one runs through `executeTraderTool`; get_tool_result and get_saved_context are added to every agent.
 */
export const ASSISTANT_TOOL_NAMES = [
  'get_account', 'get_requests', 'get_lessons', 'get_orders', 'get_positions', 'get_open_orders',
  'get_market_status', 'get_pending_events', 'get_journal', 'get_pnl', 'get_scorecard', 'get_benchmark',
  'get_price_stats', 'get_macro_regime', 'get_signals', 'get_signal_scorecard', 'get_watchlist_scan', 'get_correlation',
  'get_exposure', 'get_calendar', 'get_fundamentals', 'get_strategy_settings', 'get_state',
  'get_request_trace', 'get_app_endpoints', 'read_app', 'send_to_trader', 'request_research', 'get_policy_playbook',
  // Acting on the account directly, under the same guards and approval rules as the trader.
  'get_position_review', 'get_thesis_status', 'compare_position_actions', 'get_entry_plan', 'get_evidence',
  'get_market_context', 'get_economic_calendar', 'get_company_filings', 'get_research_updates', 'get_intraday_volume',
  'execute_entry', 'execute_exit', 'annotate_position',
  'adopt_holding', 'rearm_protection', 'confirm_protection', 'reconcile_orders', 'set_trading_paused',
  'update_trading_settings', 'get_stock_bars', 'get_stock_snapshot', 'get_stock_latest_quote',
  'get_most_active_stocks', 'get_market_movers', 'get_news', 'get_portfolio_history', 'web_search',
  'show_price_history', 'show_performance_comparison',
] as const;
const ASSISTANT_TOOLS: ToolDefinition[] = pickTools(ASSISTANT_TOOL_NAMES, [...TRADER_TOOL_DEFINITIONS, ...ASSISTANT_OWN_TOOLS, ...CHART_TOOL_DEFINITIONS]);

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
You can read everything the app itself shows: get_app_endpoints lists the engine's pages and read_app reads one. Use them for questions about the app — AI model usage, tokens and cost (/api/llm-usage), service health, the broker book, saved prompts, agent requests — before saying you cannot see something. Never say data is out of reach without checking get_app_endpoints first.
When the operator asks you to research or assess a stock, call request_research; do not relay research to the trader. Say the research has started and that its summary will appear in this chat when it finishes; do not predict its verdict.
Do what the operator asks yourself, with your own tools. You have the same broker and trade tools as the trader: execute_entry, execute_exit and annotate_position queue orders under the same guards and the same approval setting, and adopt_holding, rearm_protection, confirm_protection, reconcile_orders and set_trading_paused are the dashboard's account controls. Act only on what the operator actually asked for — never trade on your own initiative, and ask before an order whose size or levels they did not give or agree.
For an entry, read get_position_review for the stock, then get_entry_plan with supported levels, then execute_entry. For an exit the operator asked for, use basis operator_request. A stop can only be tightened. To remove a target the operator asked to drop, call annotate_position with removeTarget: true (the stop stays; on Alpaca the linked stop is re-placed at the same price). An unmanaged holding is adopted with adopt_holding. ok:true is a queue receipt: read get_orders / get_open_orders before saying an order filled or a stop rests at the broker. If a guard or the broker refuses, say exactly what refused and why.
A holding with no confirmed stop: read get_open_orders and get_orders, then fix the cause — reconcile_orders for a stuck order, rearm_protection for an uncertain protection request with nothing resting, confirm_protection for a stop that rests but is not linked, adopt_holding for an unmanaged holding. The app's protection pass places the stop itself; say it is placed only after reading it back.
Use send_to_trader only when the operator wants the trader's own judgement or asks for the trader by name. Pass their request as they said it; the trader's reply appears in this chat.
You cannot approve or reject orders waiting for approval; the operator does that in the account controls. You can save strategy settings changes with update_trading_settings, except approval/automation settings.
A one-off instruction you carry out yourself. A lasting settings change is saved with update_trading_settings.
To explain why a position was entered or exited, read get_orders for that symbol (includeDecided), then get_request_trace with the order's requestId: say who started the request, the stated reason, and whether the turn shows evidence for it. If the recorded reason contradicts the action — a hold sentence on a sell, "operator-directed" when the scheduler started it, or no reason at all — say so plainly; do not present it as a deliberate decision.
get_state shows pause, account and outstanding orders. get_journal explains decisions, newest kept when trimmed; get_scorecard reports closed-trade statistics; get_benchmark supplies verified account performance. Raw equity growth is not investment return.
Read get_strategy_settings afresh before describing current settings or suggesting a change. Its summary is the presentation baseline; use its correctly scaled values, not remembered defaults or old conversation results.
For a general settings question, lead with the saved profile, then group risk controls, investment limits and approvals into short labeled lines or bullets. Include the allowed symbols in a full overview. Answer a narrow question using just the relevant settings. Avoid raw JSON, YAML keys, revision hashes and Markdown tables; the account chat displays plain text.
Explain risk per trade as planned loss at the stop and position size as money invested. Name volatility as an annualized estimate, reward:risk as planned upside versus downside, and blank controls as not configured. A daily loss threshold halts new entries; it does not guarantee losses cannot exceed it. Distinguish alerts from entry limits and saved settings from actual holdings or trading status.
Settings questions do not wake the trader. When the operator asks to change a setting, save it with update_trading_settings and report the before and after values from its result. When you are only suggesting values, label them as suggestions and ask before saving. Never claim a change was saved unless the tool returned ok:true; if it returned errors, say what was rejected.
Read get_policy_playbook when quoting or explaining account strategy prose. Lessons are advisory observations and must not override strategy or platform behavior.
Use chart tools when the operator asks to see history or a comparison. Their results state whether a comparison is available.
Give a final answer after reading tool results. If a tool fails, state its recorded error without inventing a cause. Do not claim a queued order filled, a stop rests at the broker, or a paused trader started immediately, without reading it back.
Keep answers concise. Tools available: ${ASSISTANT_TOOLS.map(t => t.name).join(', ')}.`;

/** The account assistant's system prompt. */
export function assistantSystemPrompt(): string { return runtimeContract() + "\n\n" + SYSTEM_PROMPT; }

export class AssistantAgent {
  private readonly provider = createLiveModelProvider();
  private active: Promise<void> | null = null;
  private controller = new AbortController();
  private stopped = false;
  private readonly registry = new ToolRegistry(ASSISTANT_TOOLS, (name, input) => this.dispatchTool(name, input));

  constructor(
    private readonly wake: (msg: string) => unknown,
    /** Pause and resume go through the trader so its loop stops and starts with the flag. */
    private readonly control: { setPaused(paused: boolean): void } = { setPaused: paused => updateState({ paused }) },
  ) {}
  /** Who the operator command is recorded under: the chat user the current turn answers. */
  private actor(): string { return agentContext.getStore()?.actorId ?? 'operator'; }

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
          provider: this.provider, registry: this.registry, systemPrompt: assistantSystemPrompt(),
          messages: async () => [...compactMessages(previousChat(command.id), 24000),
            { role: 'user', content: [{ type: 'text', text: command.text }] }],
          maxTokens: config.ai.maxTokensPerTurn, signal: this.controller.signal,
        });
        const result = turn.error ?? (turn.text || 'Request processed. Check linked orders for execution status.');
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
        orders: pendingOrders(),
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
        return JSON.stringify({ error: `The trader prompt failed to render: ${err.message}` });
      }
    }

    if (name === 'get_app_endpoints') return JSON.stringify(appEndpoints());
    if (name === 'read_app') {
      const path = String(input.path ?? '').trim();
      if (!path.startsWith('/api/')) return JSON.stringify({ ok: false, error: 'path must start with /api/' });
      return JSON.stringify(await readAppEndpoint(path));
    }

    if (name === 'get_request_trace') return requestTrace(String(input.requestId ?? ''));

    if (name === 'send_to_trader') {
      const message = input.message as string;
      return JSON.stringify({ ok: true, receipt: this.wake(message) });
    }

    if (name === 'adopt_holding') {
      const target = input.target == null ? undefined : Number(input.target);
      const r = await adoptHolding(String(input.symbol ?? ''), Number(input.stop), target, this.actor());
      return JSON.stringify({ ok: true, ...r, note: 'Managed now. The protection pass places the broker stop shortly; read get_open_orders to confirm it rests.' });
    }
    if (name === 'rearm_protection') {
      await clearUnplacedProtection(String(input.symbol ?? ''), this.actor());
      return JSON.stringify({ ok: true, note: 'Uncertain request cleared. The protection pass places a fresh stop shortly; read get_open_orders to confirm it rests.' });
    }
    if (name === 'confirm_protection') {
      await confirmProtection(String(input.symbol ?? ''), String(input.stopOrderId ?? ''), input.targetOrderId as string | undefined, this.actor());
      return JSON.stringify({ ok: true, note: 'Protection linked. Trading stays paused until resumed.' });
    }
    if (name === 'reconcile_orders') {
      await sweepOrders();
      const health = serviceStatus();
      return JSON.stringify({ ok: true, ready: health.ready, issues: health.issues, unresolved: health.unresolved, protection: health.protection, unprotected: health.unprotected });
    }
    if (name === 'set_trading_paused') {
      if (typeof input.paused !== 'boolean') return JSON.stringify({ ok: false, error: 'paused must be true or false' });
      this.control.setPaused(input.paused);
      return JSON.stringify({ ok: true, paused: getState().paused });
    }

    if (name === 'update_trading_settings') {
      const result = updateTradingSettings(input as TradingSettingsUpdate);
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
