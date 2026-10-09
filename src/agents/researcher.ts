/**
 * Research worker — studies one stock and saves a verdict, for whoever asks.
 *
 * The dashboard's research button, the assistant (`research_symbol`) and the trader
 * (`request_research`) all start the same job through `startResearch`. It used to be a
 * "review only" mode of the trader, which made research wait behind trading cycles, stop
 * while trading was paused, and end with the trader's `sleep` — one BRK.B research run
 * pushed the next trading cycle back four hours. Here it has its own queue, runs alongside
 * the trader, works while trading is paused, and has no order tools and no `sleep`.
 *
 * Verdicts land where they always did: `candidate-reviews` and `position-reviews`.
 */
import { runAgentLoop } from './agentLoop';
import { ToolRegistry } from './toolRegistry';
import { runtimeContract, RESEARCH_CONTRACT } from './runtimeContract';
import { enqueueRequest, pendingRequests, updateRequest, type AgentRequest } from '../core/requests';
import { createModelProvider } from '../core/modelProvider';
import { config } from '../core/config';
import { canonicalSymbol, sameSymbol } from '../core/symbols';
import { getPolicyHash } from '../policy/load';
import { renderPolicy } from '../policy/render';
import { TRADER_REGISTRY } from '../tools/traderTools';

/** Read-only research tools plus the two verdict tools. Never order, protection, event or sleep tools. */
export const RESEARCH_TOOLS = new Set(['get_entry_plan', 'get_lessons', 'get_requests', 'get_market_status',
  'get_account', 'get_positions', 'get_open_orders', 'get_actions', 'get_journal', 'get_scorecard',
  'get_benchmark', 'get_price_stats', 'get_macro_regime', 'get_signals', 'get_watchlist_scan',
  'get_correlation', 'get_exposure', 'get_calendar', 'get_fundamentals', 'get_position_review',
  'get_thesis_status', 'get_market_context', 'get_intraday_volume', 'get_economic_calendar',
  'get_company_filings', 'get_research_updates', 'get_evidence', 'get_decision_followup',
  'get_stock_bars', 'get_stock_snapshot', 'get_stock_latest_quote', 'get_most_active_stocks',
  'get_market_movers', 'get_news', 'get_portfolio_history', 'web_search', 'read_source',
  'compare_position_actions', 'record_position_review', 'record_candidate_review',
  'record_research_review']);

/** Same validation as the dashboard route. Returns the ticker as written ("BRK.B"), upper-cased. */
export function researchTicker(raw: string): string {
  const ticker = String(raw ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9./-]{0,19}$/.test(ticker) || !canonicalSymbol(ticker)) throw new Error('A valid ticker is required');
  return ticker;
}

export function researchInstruction(ticker: string): string {
  return `Research ${ticker} under the active strategy. If held, review its original thesis, changes, alternatives and protection. If not held, investigate whether it is a good new buy candidate: build a proposed investment case, research risks and catalysts, derive supported entry/stop/target levels, and measure the entry plan. Missing historical thesis or operator-supplied levels is not a reason to stop research. Save a buy/wait/skip candidate assessment with its proposed thesis, unknowns and review date, or a material holding review. Explain what would change the conclusion. This task does not authorize trades or protection changes.
Start with get_position_review for ${ticker}. Missing evidence is unknown. Keep this task focused on that symbol.`;
}

let wakeWorker: (() => void) | null = null;

/**
 * Queue research on one stock, or return the request already queued or running for it.
 * Called inside an agent's tool call, the new request records that agent's request as its
 * parent and reuses the tool call's ID, so a replayed tool call does not queue it twice.
 */
export function startResearch(raw: string, actorId = 'operator', options: { replyToChat?: boolean } = {}): AgentRequest {
  const ticker = researchTicker(raw);
  const existing = pendingRequests('researcher').find(r => r.symbol && sameSymbol(r.symbol, ticker));
  const request = existing
    ? (options.replyToChat && !existing.replyToChat ? updateRequest(existing.id, { replyToChat: true }) : existing)
    : enqueueRequest('researcher', researchInstruction(ticker), actorId, undefined, { symbol: ticker, ...(options.replyToChat ? { replyToChat: true } : {}) });
  wakeWorker?.();
  return request;
}

export function researchStatus() {
  const pending = pendingRequests('researcher'), running = pending.find(r => r.status === 'running');
  return { lane: running
    ? { state: 'thinking', detail: `Researching ${running.symbol ?? 'a stock'}${pending.length > 1 ? ` · ${pending.length - 1} more queued` : ''}.` }
    : pending.length ? { state: 'idle', detail: `${pending.length} research request${pending.length > 1 ? 's' : ''} queued.` }
    : { state: 'idle', detail: 'No research running.' }, queued: pending.length };
}

/** Research tasks queued for the trader before research had its own worker. */
function adoptLegacyResearch(): void {
  for (const old of pendingRequests('trader').filter(r => r.mode === 'review_only')) {
    const ticker = /^(?:Research|Review) (\S+) /.exec(old.text)?.[1];
    let note = 'Research now runs in its own worker; this old trader task was not run.';
    if (ticker) {
      try { note += ` Restarted as research request ${startResearch(ticker, old.actorId).id}.`; }
      catch (err: any) { note += ` Could not restart it: ${err.message}`; }
    }
    updateRequest(old.id, { status: 'failed', result: note });
  }
}

export class Researcher {
  private readonly provider = createModelProvider(config.ai);
  private active: Promise<void> | null = null;
  private controller = new AbortController();
  private stopped = false;
  private registry: ToolRegistry | null = null;

  start(): void {
    wakeWorker = () => this.resumeQueue();
    adoptLegacyResearch();
    this.resumeQueue();
  }
  resumeQueue(): void {
    if (!this.active && !this.stopped) this.active = this.drain().finally(() => { this.active = null; });
  }
  async stop(): Promise<void> {
    this.stopped = true; wakeWorker = null; this.controller.abort();
    await this.active;
  }

  /** Built on first use: `traderTools` imports this module, so its registry is not ready at load. */
  private tools(): ToolRegistry {
    return this.registry ??= new ToolRegistry(TRADER_REGISTRY.definitions.filter(tool => RESEARCH_TOOLS.has(tool.name)),
      (name, input) => TRADER_REGISTRY.execute(name, input));
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const request = pendingRequests('researcher')[0];
      if (!request) return;
      const hash = getPolicyHash();
      updateRequest(request.id, { status: 'running' });
      try {
        const turn = await runAgentLoop({
          context: { role: 'researcher', requestId: request.id, actorId: request.actorId },
          provider: this.provider, registry: this.tools(), revision: hash,
          systemPrompt: runtimeContract() + '\n\nACCOUNT STRATEGY\n' + renderPolicy() + '\n\n' + RESEARCH_CONTRACT,
          messages: async () => [{ role: 'user', content: [{ type: 'text', text: request.text }] }],
          maxRounds: config.ai.maxToolRounds, maxTokens: config.ai.maxTokensPerTurn, signal: this.controller.signal,
          // Research cannot trade, so a trading pause does not stop it. A strategy change does:
          // the verdict would be judged against rules that no longer apply.
          beforeTool: () => { if (getPolicyHash() !== hash) throw new Error('Strategy changed; start the research again under the current strategy'); },
        });
        updateRequest(request.id, { status: turn.status, result: turn.error ?? (turn.text || 'Research finished without a written summary; check the saved assessment.') });
        if (turn.status === 'interrupted') return;
      } catch (err: any) {
        updateRequest(request.id, { status: 'failed', result: err.message });
      }
    }
  }
}
