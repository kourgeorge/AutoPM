import { readAccount, readPositions, readOrders } from '../core/accountRead';
import { DECISION_TOOL_DEFINITIONS, DECISION_TOOL_NAMES, executeDecisionTool, THESIS_SCHEMA } from './decisionTools';
import { evidenceResult, validateEvidenceIds } from '../journal/evidence';
import { validateThesis, evaluatePremises, type EntryThesis } from '../journal/thesis';
import { recordPage } from './paging';
import { validateAnnotation, actAnnotation } from '../strategy/annotation';
export { validateAnnotation, actAnnotation } from '../strategy/annotation';
export type { AnnotateInput, AnnotationValidation } from '../strategy/annotation';
import { ToolRegistry } from '../agents/toolRegistry';
import { agentContext } from '../core/agentContext';
import { listRequests } from '../core/requests';
import { broker } from '../broker';
import { BrokerRejection } from '../broker/errors';
import {
  GuardRejection,
  enterPosition,
  exitPosition,
} from '../strategy/orderManager';
// Only the reporting predicate remains here. The rules that *refuse* an order moved below
// the decision maker, into `enterPosition`, where a second caller cannot skip them.
import { dailyLossStatus } from '../strategy/riskManager';
import { etNow } from '../core/time';
import { ackEvent, getPendingEvents, type AckDisposition } from '../features/eventBus';
import { automationLevel } from '../core/automation';
import { createAction, getOpenActions, getAllActions } from '../core/actions';
import { config } from '../core/config';

import { RESEARCH_TOOL_DEFINITIONS, executeResearchTool } from './researchTools';
import {
  ALPACA_DATA_TOOL_DEFINITIONS,
  ALPACA_DATA_TOOL_NAMES,
  executeAlpacaDataTool,
} from './alpacaDataTools';
import { getRegime } from '../macro/regime';
import { correlationGate } from '../strategy/portfolioRisk';
import { exposure } from '../strategy/exposure';
import { getFundamentals } from '../collect/fundamentals';
import { collectBars, DEFAULT_COLLECT_REQUEST } from '../collect';
import { isPresent } from '../collect/types';
import { atr } from '../strategy/indicators';
import { computeSignals, signalSummary, signalTally } from '../strategy/signals';
import { computeMeanReversionSignals } from '../strategy/meanReversion';
import { reversalFilter } from '../strategy/reversal';
import { getLastTick } from '../features/lastTick';
import { entryPlan, riskAwareWatchlistScan } from '../strategy/entryPlanning';
import {
  getPositionSnapshot,
  getState,
  openPositionSnapshot,
  upsertPositionSnapshot,
  removePositionSnapshot,
} from '../state/state';
import { canonicalSymbol, isCryptoSymbol, sameSymbol } from '../core/symbols';
import {
  armOco,
  canLowerTakeProfit,
  canTighten,
  moveOcoTo,
  moveStopTo,
  type ArmResult,
  type OcoArmResult,
} from '../strategy/stopOrders';
import { decision, readDecisions, recordDecision } from '../journal/journal';
import { recordLesson, listLessons } from '../journal/lessons';
import { scorecard } from '../review/metrics';
import { benchmark, symbolStats } from '../review/benchmark';
import { openedAtFromFills } from '../review/fills';
import type { DecisionInput } from '../journal/types';
import { getPolicy, getPolicyHash } from '../policy/load';
import { logger } from '../core/logger';
import type { ToolDefinition, SignalResult } from '../core/types';
import type { OpenOrder } from '../broker/IBroker';

/**
 * Every exit names why it is selling. On 2026-10-06 a scheduled review sold ABBV and PLTR
 * with the reason "no exit thesis change; retaining the managed position" — a hold sentence
 * on a sell, credited to an operator who had asked for nothing. The basis makes the decision
 * explicit, and the two checks below refuse the exact shapes that incident took.
 */
const EXIT_BASES = ['stop_hit', 'target_hit', 'thesis_broken', 'risk_reduction', 'operator_request'] as const;
type ExitBasis = typeof EXIT_BASES[number];

/** Phrases that say the position is being kept. Narrow on purpose: a refusal costs one rewrite. */
const HOLD_LANGUAGE = /\bretain(s|ed|ing)?\b|\bno exit\b|\b(keep|keeping|continue|continuing|remain|remaining) (to )?hold(ing)?\b|\bthesis (is |remains |still )?intact\b/i;

// ── Tool definitions ──────────────────────────────────────────────────────────

export const TRADER_TOOL_DEFINITIONS: ToolDefinition[] = [
  ...DECISION_TOOL_DEFINITIONS,
  {
    name: 'get_entry_plan',
    description: 'Size a proposed long equity trade against the user risk profile using the IOC entry limit, stop loss, reward:risk, current holdings, sector limits and estimated portfolio volatility. Returns maxQty and measured risk. Choose a supported stop and target first; never move them merely to pass a budget. This is a read-only plan, not an order or an approval.',
    input_schema: { type: 'object', properties: {
      symbol: { type: 'string' }, price: { type: 'number', minimum: 0.01 },
      stopLoss: { type: 'number', minimum: 0.01 }, takeProfit: { type: 'number', minimum: 0.01 },
    }, required: ['symbol', 'price', 'stopLoss', 'takeProfit'] },
  },
  { name: 'get_lessons', description: 'Read the latest active, evidence-linked advisory lessons.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_requests', description: 'Read recent requests with their IDs, initiating actor, processing status, and linked action IDs. Read get_actions for broker outcomes.', input_schema: { type: 'object', properties: {}, required: [] } },
  {
    name: 'get_market_status',
    description: 'Get current market status: open/closed, ET time, and minutes until next open or close.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_account',
    description: 'Get account state: equity, cash, buying power, daily P&L vs start-of-day, and whether the daily loss limit is breached.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_positions',
    description: 'Get all currently open positions with symbol, qty, avg cost, market value, and unrealized P&L.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_open_orders',
    description: "Read broker orders grouped by position. Match ownership by recorded order ID. Desired stop levels and actual broker stops are separate facts; inspect both price and quantity before claiming full protection.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'execute_entry',
    description: "Queue a whole-share long equity entry under the active strategy. ok:true is a queue receipt. An automatic or human-approved action is executed separately using an IOC limit buy; fills and broker protection are reconciled later. Inspect get_actions before reporting any fill or stop as confirmed.",
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        qty: { type: 'number', description: 'Number of shares to buy.' },
        price: { type: 'number', description: 'Current/expected entry price.' },
        stopLoss: { type: 'number', description: 'Absolute stop-loss price. A real sell stop is placed at the venue at this level, so choose it as a price you are content to be sold at unattended, not as a rough marker.' },
        takeProfit: { type: 'number', description: 'Absolute take-profit price.' },
        atr: { type: 'number', description: 'ATR at entry. Recorded as the baseline the stop was sized against.' },
        reason: { type: 'string', description: 'Why you are buying now: the setup and the measured numbers behind it (signals, levels), in one or two sentences.' },
        thesis: THESIS_SCHEMA,
        invalidation: { type: 'string', description: 'What would make you exit besides the stop and target: the condition that would mean the reason above is no longer true. Later exits are judged against this.' },
        eventId: { type: 'string', description: 'Optional — the MACHINE EVENTS id this entry answers, verbatim. Links the decision to what prompted it.' },
      },
      required: ['symbol', 'qty', 'price', 'stopLoss', 'takeProfit', 'atr', 'reason', 'invalidation', 'thesis'],
    },
  },
  {
    name: 'annotate_position',
    description: "Queue a stop/target adjustment for an already managed holding. Human adoption is required for unmanaged holdings. Stops can only tighten upward; targets can only move closer. The original entry thesis is preserved; this management rationale and broker confirmation are recorded separately.",
    input_schema: {
      type: 'object',
      properties: {
        symbol:       { type: 'string', description: 'Ticker exactly as it appears in the portfolio.' },
        stopLoss:     { type: 'number', description: 'Absolute stop-loss price. Must be below the CURRENT price — an inherited position may be underwater, in which case a sane stop sits above its original entry.' },
        takeProfit:   { type: 'number', description: 'Absolute take-profit price. Must be above the current price.' },
        entryPrice:   { type: 'number', description: 'Original entry price. Optional — defaults to the venue cost basis when this system has no record of the entry.' },
        thesis:       { type: 'string', description: 'One-sentence holding thesis: why you are still in, and what would invalidate it.' },
      },
      required: ['symbol', 'stopLoss', 'thesis'],
    },
  },
  {
    name: 'execute_exit',
    description: "Queue an exit from a managed position. Omit qty to request the whole holding, or provide whole shares to sell part. Use record_position_review for a material holding assessment and ack_event for event handling. Existing protection stays until the executor attempts the exit. Inspect action status for approval, submission and fills.",
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        evidenceIds: { type: 'array', maxItems: 10, items: { type: 'string' }, description: 'Observation IDs supporting this exit. Required for thesis_broken and risk_reduction.' },
        basis: {
          type: 'string',
          enum: [...EXIT_BASES],
          description: 'Why you are selling now. stop_hit / target_hit = the price reached the recorded level; thesis_broken = what the entry relied on is no longer true; risk_reduction = cutting exposure for a portfolio or risk reason; operator_request = the operator explicitly asked for this exit. A scheduled review is not an operator request.',
        },
        reason: { type: 'string', description: 'One or two sentences: what changed since the last hold, with the numbers that show it. Must describe a sell, not a hold.' },
        qty: { type: 'number', description: 'Optional — shares to sell. Must be a whole number no greater than the position held. Omit to close the whole position.' },
        eventId: { type: 'string', description: 'Optional — the MACHINE EVENTS id this exit answers, verbatim. Links the decision to what prompted it.' },
      },
      required: ['symbol', 'basis', 'reason'],
    },
  },
  {
    name: 'get_pending_events',
    description: 'Read the full evidence for every machine event that has fired and not been acked. The MACHINE EVENTS block in the cycle context is a summary of these; call this for the numbers behind a headline.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_actions',
    description: "Read automatic and manual actions and their authoritative parameters, statuses, and broker results. Only pending actions await a human decision. approved waits for execution; submitted/partial await fills; unknown needs broker review. No model can approve or reject an action.",
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Optional — filter to one symbol.' },
        includeDecided: { type: 'boolean', description: 'Include already-decided actions (approved/rejected/expired/executed/failed), not just ones still open. Default false — only pending and approved-not-yet-executed.' },
      },
      required: [],
    },
  },
  {
    name: 'ack_event',
    description: "Record how an incident is being handled. acting requires an existing actionId linked to this event; the incident remains open until that action succeeds. Acknowledging a critical or urgent incident records observation without resolving it. ignoring requires a reason and explicitly declines action.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The event id, verbatim from MACHINE EVENTS or get_pending_events.' },
        actionId: { type: 'string', description: 'Required for acting: an existing action linked to this event.' },
        disposition: {
          type: 'string',
          enum: ['acting', 'acknowledged', 'ignoring'],
          description: 'acting = you are placing an order about it now; acknowledged = seen, no action needed; ignoring = deliberately declining to act.',
        },
        note: { type: 'string', description: 'One sentence: why this disposition. Required when disposition is "ignoring". For "acknowledged": supply a note only when you have reasoning worth preserving across cycles — e.g. why you are holding despite a warning. Omit for routine feed events on symbols you do not hold; those produce no journal entry.' },
      },
      required: ['id', 'disposition'],
    },
  },
  {
    name: 'get_journal',
    description: 'Read past decisions, oldest first: entries, exits, holds, guard vetoes and venue rejections, each with its rationale and the numbers it intended. This is the durable record of what this system has done and why.',
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
    name: 'get_scorecard',
    description: 'Measured performance over COMPLETED round trips, computed from venue fills joined to the journal — win rate, expectancy in dollars, percent and R multiples, hold times split by winners and losers, drawdown, stop discipline, and breakdowns by symbol and policy version. Every number is arithmetic, not an estimate; never state your win rate, expectancy or stop-respect rate without calling this. Read `caveats` first — it states what the sample cannot support. Open positions are excluded, because half a trade has no outcome.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Optional — one symbol only.' },
        days: { type: 'integer', description: 'Optional lookback on EXIT date. Omit for all history.', minimum: 1, maximum: 3650 },
      },
      required: [],
    },
  },
  {
    name: 'get_benchmark',
    description: 'The scoreboard: what the ACCOUNT returned over a window against what SPY returned over the same sessions, plus the Sharpe ratio and max drawdown of each. This is the only tool that answers "was trading this worth doing instead of holding the index" — get_scorecard measures the SHAPE of the trades (win rate, expectancy, stop discipline) and can look excellent while this shows the index beat you, so a claim about performance needs both. Reads the equity curve, so it covers open positions too, and it works before any round trip has closed. Read `caveats` first: a short window, or a deposit sitting inside it, makes the excess figure unattributable. Never state a return, an excess or a Sharpe you did not read from here.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Calendar lookback (default 30). `window.sessions` reports how many sessions the two series actually shared.', minimum: 2, maximum: 3650 },
      },
      required: [],
    },
  },
  {
    name: 'get_price_stats',
    description: 'Sharpe ratio, annualized volatility, max drawdown and total return for ONE symbol\'s own price series — not compared to your account or to SPY (that is get_benchmark). Same methodology as get_benchmark: simple daily returns, zero risk-free rate, annualized by sqrt(252) trading sessions. Use this for "what is <TICKER>\'s Sharpe/volatility/drawdown" for any symbol, including ones you do not hold. Read `caveats` first — windows under 5 sessions return null instead of a number, and short windows make every figure noisy. Never compute a Sharpe by hand from bars; this is the only validated source for one.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol.' },
        days: { type: 'integer', description: 'Calendar lookback (default 30).', minimum: 2, maximum: 3650 },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'write_lesson',
    description: "Store a concise advisory observation with existing journal decision IDs as evidence. Do not restate strategy rules or write routine cycle summaries. Lessons cannot change permissions or settings; the operator can edit or retire them.",
    input_schema: {
      type: 'object',
      properties: {
        evidenceIds: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'IDs of existing journal decisions supporting this observation.' },
        counterEvidenceIds: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Distinct journal decisions contradicting this observation.' },
        reviewAfter: { type: 'string', description: 'Future review datetime within one year; defaults to 30 days.' },
        scope: { type: 'string', maxLength: 300, description: 'Market regime, setup or circumstances where this observation applies.' },
        lesson: {
          type: 'string',
          description: 'The lesson in prose: what happened, what it generalizes to, and what you will do differently. Markdown is fine.',
        },
      },
      required: ['lesson', 'evidenceIds'],
    },
  },
  {
    name: 'get_macro_regime',
    description: 'Classify the current macro regime (expansion, late_cycle, recession, recovery) based on GDP growth, unemployment, CPI, yield curve, and VIX from FRED. Cached for 6h. Use this to condition entry aggressiveness: tighten in late_cycle/recession, widen in expansion/recovery.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_signals',
    description: 'Compute the five entry signals — EMA Momentum, Trend Strength, Volume, Breakout, MACD — for any symbol, each scored -1 (strongly bearish) to +1 (strongly bullish), plus tally.composite (their mean, the number to threshold on), the reversal filter, ATR and the last close. All five measure trend and are highly correlated, so their COUNTS inflate: 5/5 bullish is closer to one confirmation counted five times, which is why the composite keeps the magnitude the vote throws away. reversal is separate and NOT in the composite — it is contrarian and monthly, its score is negative when the name has already run, and chasing: true means the move has cleared the chase threshold for its market-cap bucket. This is the SAME deterministic computation that fills the signal evidence on an entry_signal event, run on demand: use it for a candidate that has not fired an event, so a signal breakdown you report is one you actually measured. Never state which signals are bullish or bearish, or quote a composite or a reversal reading, without this tool or get_pending_events.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol to score.' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_watchlist_scan',
    description: 'Read compact stable pages of the last computed watchlist. Follow nextOffset with snapshotId until null. Compact rows include composite, meanReversionComposite, price staleness, RSI, ATR and risk fit; details:true retrieves full signal evidence from the SAME snapshot. All non-held symbols are preserved, including notScored rows; heldExcluded identifies holdings. tickAt and ageMs describe freshness. Signals and riskAdjustedScore are measured heuristics, not independent confirmations or expected returns. Get fresh get_signals and an entry plan with supported levels for a researched candidate.',
    input_schema: {
      type: 'object',
      properties: { snapshotId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 }, details: { type: 'boolean' } },
      required: [],
    },
  },
  {
    name: 'get_correlation',
    description: 'Check how correlated a candidate entry is with current holdings. Returns the max pairwise correlation and a sizing recommendation. Call this BEFORE execute_entry to assess diversification.',
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
    description: 'Measure the shape of the book: per-position weight as a percentage of equity, sector, gross deployed, cash, the largest single-name and sector weights, a Herfindahl concentration index, and every held-vs-held correlation pair. This is the ONLY source of a sector or a weight in this system — a sector weight you did not read from here is a fabricated one. Sectors are null where the venue reports none (normal for ETFs) and the caveats name which.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_calendar',
    description: 'Read the scheduled catalysts for one symbol: the next earnings date and how many days away it is, whether that date is confirmed or still an estimate, the window when Yahoo reports more than one candidate day, the ex-dividend and dividend dates, and the last four quarters of EPS actual vs estimate. This is the ONLY source of an earnings date in this system — a date you did not read here is a fabricated one, and a web search is not a substitute. An ATR stop does not protect across an earnings gap, because a gap is jumped and not hit, so check this before opening and before deciding to hold through a print. Fields are null where Yahoo reports nothing, never zero; ETFs have no earnings at all and the caveats say so. Where the date is an estimate, saying so is the honest answer.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol.' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_fundamentals',
    description: 'Measure how crowded, liquid, leveraged and well-regarded one name is: short interest as a percentage of float and its direction of travel, float, institutional and insider holdings, beta, market cap, average and 10-day volume, the 52-week range, cash, debt, debt-to-equity, current ratio, profit margin, revenue and earnings growth, free cash flow, and how many analysts raised or cut their EPS estimate in the last 30 days. Estimates being cut into a momentum entry is the most useful thing here. Percentages are already scaled — do not re-scale them. Fields are null where Yahoo reports nothing, never zero, and short interest is published roughly biweekly so the caveats name its as-of date and age. Contains no price targets and no analyst recommendations by design: those are another system\'s verdicts, not measurements.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol.' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'sleep',
    description: "Finish this trader turn and set the maximum delay before another cycle. Call separately after inspecting all earlier action results. Remaining calls in the same batch will not execute. Typical cadence: 60 minutes while open, 240 while closed.",
    input_schema: {
      type: 'object',
      properties: {
        minutes: {
          type: 'number', minimum: 1, maximum: 1440,
          description: 'Maximum minutes until next cycle. MUST be 60 when market is open, MUST be 240 when market is closed. Never use 10 during closed hours.',
        },
        reason: { type: 'string', description: 'Why this duration was chosen.' },
      },
      required: ['minutes', 'reason'],
    },
  },
  // Native Alpaca market data — bars, snapshots, movers, news — direct REST calls.
  // Order-placement tools are excluded: those go through enterPosition/exitPosition.
  ...ALPACA_DATA_TOOL_DEFINITIONS,
  // General web search for anything not covered by Alpaca's market data API.
  ...RESEARCH_TOOL_DEFINITIONS,
];

// ── Executor ──────────────────────────────────────────────────────────────────

async function dispatchTraderTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  try {
    switch (name) {
      case 'sleep': return JSON.stringify({ ok: true, sleepMs: Number(input.minutes) * 60000 });
      case 'get_lessons': return JSON.stringify(listLessons(20, true));
      case 'get_requests': return JSON.stringify(listRequests());
      case 'get_market_status':   return await toolGetMarketStatus();
      case 'get_account':         return await toolGetAccount();
      case 'get_positions':       return await toolGetPositions();
      case 'get_open_orders':     return await toolGetOpenOrders();
      case 'get_macro_regime':    return await toolGetMacroRegime();
      case 'get_signals':         return await toolGetSignals(input);
      case 'get_watchlist_scan': {
        const scan = input.snapshotId ? { rows: [] } : await riskAwareWatchlistScan();
        const page = recordPage(name, scan, 'rows', input);
        const result = input.details ? page : { ...page, rows: page.rows.map((r: any) => ({ symbol: r.symbol, price: r.price, priceStale: r.priceStale, notScored: r.notScored, composite: r.tally.composite, meanReversionComposite: r.meanReversionTally.composite, chasing: r.reversal.chasing, atr: r.atr, rsi: r.rsi, riskAdjustedScore: r.riskAdjustedScore ?? null, riskFit: r.riskFit ? { allowed: r.riskFit.allowed, maxQty: r.riskFit.maxQty, violations: r.riskFit.violations } : null })) };
        return JSON.stringify(result);
      }
      case 'get_entry_plan':     return JSON.stringify(await entryPlan(input as { symbol: string; price: number; stopLoss: number; takeProfit: number }));
      case 'get_correlation':     return await toolGetCorrelation(input);
      case 'get_exposure':        return await toolGetExposure();
      case 'get_calendar':        return await toolGetCalendar(input);
      case 'get_fundamentals':    return await toolGetFundamentals(input);
      case 'execute_entry':       return await toolExecuteEntry(input);
      case 'annotate_position':   return await toolAnnotatePosition(input);
      case 'execute_exit':        return await toolExecuteExit(input);
      case 'get_pending_events':  return toolGetPendingEvents();
      case 'get_actions':       return toolGetActions(input);
      case 'ack_event':           return toolAckEvent(input);
      case 'get_journal':         return toolGetJournal(input);
      case 'get_scorecard':       return toolGetScorecard(input);
      case 'get_benchmark':       return await toolGetBenchmark(input);
      case 'get_price_stats':     return await toolGetPriceStats(input);
      case 'write_lesson':        return toolWriteLesson(input);
      // No `sleep` case: trader.ts intercepts it before dispatch (it sets the next cycle
      // delay, which only the agent loop can do), and it is not an assistant tool.
      default:
        if (DECISION_TOOL_NAMES.has(name)) return executeDecisionTool(name, input);
        if (ALPACA_DATA_TOOL_NAMES.has(name)) return await executeAlpacaDataTool(name, input);
        return (await executeResearchTool(name, input))
          ?? JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err: any) {
    logger.error(`[TraderTool:${name}] ${err.message}`);

    // The two tools that place orders already catch these and journal them; reaching here
    // means some other path threw one. Flattening to `err.message` is what turned a 403
    // with a reason into a bare status code the model then explained for itself, so the
    // typed fields survive here too — the safety net, not the primary handler.
    if (err instanceof GuardRejection) {
      return JSON.stringify({
        error: err.message, rejectedBy: 'guard', rule: err.rule, venueMessage: err.venueMessage,
      });
    }
    if (err instanceof BrokerRejection) {
      return JSON.stringify({
        error: err.message,
        rejectedBy: 'broker',
        status: err.status,
        venueCode: err.venueCode,
        venueMessage: err.venueMessage,
      });
    }
    return JSON.stringify({ error: err.message });
  }
}

const OBSERVATION_TOOLS = new Set(['get_market_status','get_account','get_positions','get_open_orders','get_macro_regime','get_signals','get_watchlist_scan','get_entry_plan','get_correlation','get_exposure','get_calendar','get_fundamentals','get_pending_events', ...ALPACA_DATA_TOOL_NAMES, 'web_search']);
export const TRADER_REGISTRY = new ToolRegistry(TRADER_TOOL_DEFINITIONS, async (name, input) => {
  const result = await dispatchTraderTool(name, input);
  return OBSERVATION_TOOLS.has(name) ? evidenceResult(name, result, typeof input.symbol === 'string' ? canonicalSymbol(input.symbol) : undefined) : result;
});
export const executeTraderTool = (name: string, input: Record<string, unknown>) => TRADER_REGISTRY.execute(name, input);

// ── Implementations ───────────────────────────────────────────────────────────

export interface MarketStatusSnapshot {
  isOpen: boolean;
  etTime: string;
  utcTime: string;
  isWeekend: boolean;
  minutesUntilChange: number | null;
  changeLabel: string;
}

/**
 * Shared by the `get_market_status` tool and the cycle-context header, so the two never
 * derive market-open/close timing differently.
 */
export async function getMarketStatusSnapshot(): Promise<MarketStatusSnapshot> {
  const isOpen = await broker.isMarketOpen();
  const { day, hours, minutes, timeStr } = etNow();
  const isWeekend = day === 0 || day === 6;
  const etMinutes = hours * 60 + minutes;
  const marketOpen = 9 * 60 + 30;
  const marketClose = 16 * 60;

  let minutesUntilChange: number | null = null;
  let changeLabel = 'next trading day';
  if (isOpen) {
    minutesUntilChange = marketClose - etMinutes;
    changeLabel = 'market close';
  } else if (!isWeekend && etMinutes < marketOpen) {
    minutesUntilChange = marketOpen - etMinutes;
    changeLabel = 'market open';
  }

  return {
    isOpen,
    etTime: timeStr,
    utcTime: new Date().toISOString(),
    isWeekend,
    minutesUntilChange,
    changeLabel,
  };
}

async function toolGetMarketStatus(): Promise<string> {
  return JSON.stringify(await getMarketStatusSnapshot());
}

async function toolGetMacroRegime(): Promise<string> {
  const regime = await getRegime();
  return JSON.stringify(regime);
}

/**
 * The five signal scores for one symbol, plus their composite and the reversal filter.
 *
 *
 * Until this existed, signals could ONLY reach the trader as `evidence.signals` on an
 * `entry_signal` event — which fires on an EMA cross, not on being asked about. A
 * discretionary scan ("enter the best setup on the watchlist") therefore had no way to
 * obtain them, and the rationale it wrote named signals it had never seen, using the
 * five names PLAYBOOK.md lists.
 *
 * Same bar request and same `minBars` floor as `collectAndCompute`, so a scan and an
 * event cannot report different scores for the same symbol at the same moment.
 */
async function toolGetSignals(input: Record<string, unknown>): Promise<string> {
  const symbol = String(input.symbol ?? '').toUpperCase();
  const policy = getPolicy();

  const bars = await collectBars(
    symbol,
    DEFAULT_COLLECT_REQUEST.barLimit,
    DEFAULT_COLLECT_REQUEST.timeframe,
  );

  if (!isPresent(bars)) {
    return JSON.stringify({
      symbol,
      error: `no bars from ${bars.source}: ${bars.error}`,
      signals: [],
    });
  }

  // Staleness is refusal, not a caveat: `buildWatchlistData` declines to score a stale
  // series, and a tool that scored one anyway would be a second opinion on what
  // "scoreable" means.
  if (bars.stale) {
    return JSON.stringify({
      symbol,
      error: `bars are stale (asOf ${bars.asOf}) — not scoring`,
      signals: [],
    });
  }

  if (bars.value.length < policy.strategy.minBars) {
    return JSON.stringify({
      symbol,
      error: `insufficient history: ${bars.value.length} bars, need ${policy.strategy.minBars}`,
      signals: [],
    });
  }

  const signals = computeSignals(bars.value, policy);
  const meanReversionSignals = computeMeanReversionSignals(bars.value, policy);
  const atrSeries = atr(bars.value, policy.strategy.atrPeriod);
  const lastBar = bars.value[bars.value.length - 1];

  // Fetched rather than read from the cache, unlike the tick's cache-only path: this is the
  // "read it fresh, and for a symbol the watchlist may not cover" tool, so the one symbol it
  // was asked about is worth a round trip. A failure costs the size adjustment and nothing
  // else — the filter says `sizeBucket: 'unknown'` for itself — so it must not take the tool
  // down, and an unreachable Yahoo is not evidence about the trade.
  let marketCap: number | null = null;
  try {
    marketCap = (await getFundamentals(symbol)).liquidity.marketCap;
  } catch {
    marketCap = null;
  }

  return JSON.stringify({
    symbol,
    asOf: bars.asOf,
    timeframe: DEFAULT_COLLECT_REQUEST.timeframe,
    bars: bars.value.length,
    lastClose: lastBar.c,
    atr: atrSeries.length > 0 ? parseFloat(atrSeries[atrSeries.length - 1].toFixed(2)) : null,
    signals,
    tally: signalTally(signals),
    meanReversion: {
      signals: meanReversionSignals,
      tally: signalTally(meanReversionSignals),
      summary: signalSummary(meanReversionSignals),
    },
    reversal: reversalFilter(bars.value, marketCap),
    summary: signalSummary(signals),
    caveats: [
      'The five signals all measure trend and are highly correlated, so their counts inflate: a 5/5 tally is closer to one confirmation counted five times. tally.composite is their mean and is the number to threshold on.',
      'reversal is NOT in the composite. Its score reads the opposite way to a signal score — negative means the name has already run — and it answers "is this too late to chase" over about a month, not "is this a good entry today".',
      'meanReversion is a second price-derived signal family; independence from trend has not been measured — it answers a different question (has this run too far from its own recent history) than the trend family does (is this trending). Do not average it into tally.composite; read the two composites separately.',
    ],
  });
}

async function toolGetCorrelation(input: Record<string, unknown>): Promise<string> {
  const { symbol } = input as { symbol: string };
  const result = await correlationGate(symbol);
  return JSON.stringify({
    symbol,
    maxCorrelation: result.maxCorrelation == null ? null : parseFloat(result.maxCorrelation.toFixed(3)),
    minCorrelation: result.minCorrelation ?? null,
    mostNegativelyCorrelatedWith: result.mostNegativelyCorrelatedWith ?? null,
    measuredPairs: result.measuredPairs ?? 0,
    missingSymbols: result.missingSymbols ?? [],
    mostCorrelatedWith: result.mostCorrelatedWith,
    recommendation: !result.allowed ? 'SKIP' : result.sizeMultiplier < 1.0 ? 'REDUCE' : 'OK',
    sizeMultiplier: result.sizeMultiplier,
    detail: result.detail,
  });
}

/** Thin: the arithmetic lives in `strategy/exposure.ts`, rounding is the only thing done here. */
async function toolGetExposure(): Promise<string> {
  const e = await exposure();
  const r = (n: number, dp = 2) => parseFloat(n.toFixed(dp));

  return JSON.stringify({
    at: e.at,
    equity: r(e.equity),
    positions: e.positions.map(p => ({
      symbol: p.symbol,
      qty: p.qty,
      marketValue: r(p.marketValue),
      weightPct: r(p.weightPct),
      sector: p.sector,
    })),
    grossDeployedPct: r(e.grossDeployedPct),
    cashPct: r(e.cashPct),
    maxWeightPct: r(e.maxWeightPct),
    maxWeightSymbol: e.maxWeightSymbol,
    hhi: r(e.hhi, 3),
    bySector: Object.fromEntries(
      Object.entries(e.bySector).map(([k, v]) => [k, { symbols: v.symbols, weightPct: r(v.weightPct) }]),
    ),
    maxSectorWeightPct: r(e.maxSectorWeightPct),
    maxSectorName: e.maxSectorName,
    correlations: e.correlations.map(c => ({ a: c.a, b: c.b, corr: r(c.corr, 3) })),
    maxHeldCorrelation: e.maxHeldCorrelation == null ? null : r(e.maxHeldCorrelation, 3),
    maxHeldPair: e.maxHeldPair,
    caveats: e.caveats,
  });
}

/**
 * Two projections of ONE cached fetch (`src/collect/fundamentals.ts`): the catalysts here, the
 * measurements below. Thin on purpose — every unit conversion and every caveat is decided in the
 * mapper, so there is one place where a number's meaning is fixed.
 *
 * No `error` field on a symbol Yahoo simply has nothing for: `logger.ts` short-circuits any
 * result carrying `error` to `ERROR: …`, which would make an ETF's perfectly normal answer read
 * as a failed call. A thrown fetch still surfaces as an error, via the executor's catch.
 */
async function toolGetCalendar(input: Record<string, unknown>): Promise<string> {
  const symbol = String(input.symbol ?? '').toUpperCase();
  const f = await getFundamentals(symbol);
  return JSON.stringify({
    symbol: f.symbol,
    ...f.calendar,
    fetchedAt: f.fetchedAt ?? null,
    source: f.source,
    caveats: f.caveats,
  });
}

async function toolGetFundamentals(input: Record<string, unknown>): Promise<string> {
  const symbol = String(input.symbol ?? '').toUpperCase();
  const f = await getFundamentals(symbol);
  return JSON.stringify({
    symbol: f.symbol,
    crowding: f.crowding,
    liquidity: f.liquidity,
    balanceSheet: f.balanceSheet,
    revisions: f.revisions,
    modulesPresent: f.modulesPresent,
    fetchedAt: f.fetchedAt ?? null,
    source: f.source,
    caveats: f.caveats,
  });
}

export interface AccountSnapshot {
  equity: number;
  cash: number;
  buyingPower: number;
  startOfDayEquity: number | null;
  dailyPnL: number | null;
  dailyPnLPct: number | null;
  lossLimitPct: number;
  lossLimitBreached: boolean | null;
  lossLimitUnmeasurable?: string;
  maxPositions: number;
}

/**
 * Shared by the `get_account` tool and the cycle-context header, so the two never compute the
 * daily-loss verdict two ways.
 */
export async function getAccountSnapshot(): Promise<AccountSnapshot> {
  const account = await readAccount();
  const risk = getPolicy().risk;

  // The daily reset used to happen HERE, on the first account call of each day, which made
  // the baseline of the daily loss limit depend on whether the model chose to call a tool.
  // It is now `ensureDailyReset()` at the top of every scheduler tick — deterministic, and
  // keyed off the ET date rather than the UTC one.
  // The baseline is reported RAW, and so is the verdict. This used to read
  // `getState().startOfDayEquity || account.equity`, which meant that with no baseline yet the
  // model was handed `dailyPnLPct: 0, lossLimitBreached: false` — a manufactured flat day. Of
  // the three sites that made that substitution this was the worst, because the other two only
  // failed to stop a decision while this one fed a made-up number into it. `null` says "unknown",
  // which is a thing the model can reason about; `0` is not.
  const startEquity = getState().startOfDayEquity;
  const daily = dailyLossStatus(account.equity, startEquity, risk.maxDailyLossPct);
  const measurable = daily.state !== 'unmeasurable';

  return {
    equity: account.equity,
    cash: account.cash,
    buyingPower: account.buyingPower,
    startOfDayEquity: measurable ? startEquity : null,
    dailyPnL: measurable ? parseFloat((account.equity - startEquity).toFixed(2)) : null,
    dailyPnLPct: daily.dayPnLPct === null ? null : parseFloat(daily.dayPnLPct.toFixed(2)),
    lossLimitPct: risk.maxDailyLossPct * 100,
    lossLimitBreached: measurable ? daily.state === 'breached' : null,
    // Present only when there is nothing to measure, and it says what is blocked as well as why:
    // entries are refused while this is set, exits are not.
    lossLimitUnmeasurable: measurable
      ? undefined
      : `${daily.reason}. Entries are blocked until the daily reset establishes a baseline; exits are unaffected.`,
    maxPositions: risk.maxPositions,
  };
}

async function toolGetAccount(): Promise<string> {
  return JSON.stringify(await getAccountSnapshot());
}

/**
 * What this system places at the venue, stated once because both the tool and the cycle context
 * have to say it, and it is the fact the model got wrong in both directions.
 *
 * It used to say "only market orders", which was true and is now false: entries arm a real
 * resting sell stop. The correction that matters is the one about IDENTITY — the id, not the
 * type, is what says whose order it is.
 */
const VENUE_STOPS_CAVEAT =
  'This system queues entry/exit orders and manages protective stops and targets. A stop whose orderId matches the position\'s stopOrderIdRecordedHere is this system\'s own, placed from the recorded stopLevel; any other order listed here was placed outside this system. The two facts stay separate on purpose: stopLevelRecordedHere is what the stop detector compares the price against while this process runs, and venueStop is what protects the position when it is not running. Crypto can have no venue stop at all — the venue rejects a plain stop on a coin.';

export interface BrokerOrderView {
  /** Every order resting at the venue, ungrouped. */
  orders: OpenOrder[];
  byPosition: Array<{
    symbol: string;
    qty: number;
    /** The level the `stop_breach` detector compares the price against, while this runs. */
    stopLevelRecordedHere: number | null;
    /** The order id this system believes its own stop rests under, if it armed one. */
    stopOrderIdRecordedHere: string | null;
    /**
     * The stop actually resting at the venue, and whether it is this system's.
     *
     * `null` means NOTHING protects this position when the process is down. That is the fact
     * worth surfacing, and it stays a separate field from `stopLevelRecordedHere` rather than
     * being merged into "has a stop", because which place the stop lives in is the question.
     */
    venueStop: { orderId: string; level: number; isOurs: boolean } | null;
    orders: OpenOrder[];
  }>;
  /** Resting orders with no matching open position — a buy waiting to fill, or an orphan. */
  ordersWithoutPosition: OpenOrder[];
  /**
   * Symbols where a stop exists in both places and the two levels differ — which is TWO
   * different situations, and reading them as one was the old shape's mistake.
   *
   *  - `kind: 'ours'` — the venue stop is this system's own, and state disagrees with it about
   *    the level. That is a DEFECT: one order, two accounts of it. A tighten that the venue
   *    accepted while the state write failed, or the reverse.
   *  - `kind: 'other_actor'` — two real levels, set by two actors, both standing. Not a defect;
   *    the earlier one will fire first and neither is wrong.
   */
  stopMismatches: Array<{
    symbol: string;
    recordedHere: number;
    atVenue: number;
    kind: 'ours' | 'other_actor';
  }>;
}

/**
 * The join between the venue's order book, the open positions, and this system's own recorded
 * stop levels — one implementation, because the tool and the cycle context must not be able to
 * disagree about it. The three facts stay SEPARATE in the result: nothing here collapses "has a
 * stop somewhere" into a single boolean, since which place the stop lives in is the whole
 * question.
 */
export async function brokerOrderView(): Promise<BrokerOrderView> {
  const [orders, positions] = await Promise.all([
    readOrders(),
    readPositions(),
  ]);
  const snapshots = getState().positionSnapshots;

  const claimed = new Set<string>();
  const byPosition = positions.map(p => {
    const key = canonicalSymbol(p.symbol);
    const mine = orders.filter(o => canonicalSymbol(o.symbol) === key);
    mine.forEach(o => claimed.add(o.id));

    const snap = Object.values(snapshots).find(s => canonicalSymbol(s.symbol) === key);
    const recordedId = snap?.stopOrderId ?? null;

    // Ours FIRST, by id, before falling back to "any resting stop". On a position carrying both
    // this system's stop and a hand-placed one, taking whichever came back first would report
    // someone else's level as ours and call a perfectly consistent state a mismatch.
    const resting = mine.filter(
      o => o.side === 'sell' && (o.type === 'stop' || o.type === 'stop_limit') && o.stopPrice != null,
    );
    const ours = recordedId ? resting.find(o => o.id === recordedId) : undefined;
    const chosen = ours ?? resting[0];

    return {
      symbol: p.symbol,
      qty: p.qty,
      stopLevelRecordedHere: snap?.stopLevel ?? null,
      stopOrderIdRecordedHere: recordedId,
      venueStop: chosen
        ? { orderId: chosen.id, level: chosen.stopPrice!, isOurs: chosen.id === recordedId }
        : null,
      orders: mine,
    };
  });

  const stopMismatches: BrokerOrderView['stopMismatches'] = [];
  for (const row of byPosition) {
    if (row.stopLevelRecordedHere == null || row.venueStop == null) continue;
    // A cent of tolerance: the same level rounded differently is not a disagreement.
    if (Math.abs(row.venueStop.level - row.stopLevelRecordedHere) > 0.01) {
      stopMismatches.push({
        symbol: row.symbol,
        recordedHere: row.stopLevelRecordedHere,
        atVenue: row.venueStop.level,
        kind: row.venueStop.isOurs ? 'ours' : 'other_actor',
      });
    }
  }

  return {
    orders,
    byPosition,
    ordersWithoutPosition: orders.filter(o => !claimed.has(o.id)),
    stopMismatches,
  };
}

async function toolGetOpenOrders(): Promise<string> {
  const view = await brokerOrderView();

  const caveats = [VENUE_STOPS_CAVEAT];
  for (const m of view.stopMismatches) {
    caveats.push(
      m.kind === 'ours'
        ? `${m.symbol}: THIS SYSTEM'S OWN stop rests at the venue at $${m.atVenue} while the level recorded here is $${m.recordedHere}. One order, two accounts of it — the venue's is the one that will actually fire. This is a defect, not two actors; report it rather than trading around it.`
        : `${m.symbol}: stop recorded here is $${m.recordedHere} and a stop order placed OUTSIDE this system rests at the venue at $${m.atVenue}. Both are real; they are different levels set by different actors, and the higher one fires first.`,
    );
  }

  // A recorded level with nothing resting behind it means the position is protected only while
  // this process runs. Said out loud, because a quiet `venueStop: null` in a JSON blob is the
  // kind of absence that reads as "fine".
  const naked = view.byPosition.filter(r => r.stopLevelRecordedHere != null && r.venueStop == null);
  if (naked.length > 0) {
    caveats.push(
      `No stop is resting at the venue for ${naked.map(r => r.symbol).join(', ')}. `
      + `The recorded level is watched by the breach detector, which only watches while this `
      + `process is running — these positions are unprotected overnight and through a crash. `
      + `For a crypto pair that is permanent (the venue rejects a plain stop on a coin); for an `
      + `equity the stop sweep retries every minute, so it is either very new or being refused.`,
    );
  }
  const unrecognised = view.orders.filter(o => o.type === 'other');
  if (unrecognised.length > 0) {
    caveats.push(
      `Order types this system does not model, reported verbatim: ${unrecognised.map(o => `${o.symbol} ${o.rawType}`).join(', ')}.`,
    );
  }

  return JSON.stringify({
    restingOrderCount: view.orders.length,
    byPosition: view.byPosition,
    ordersWithoutPosition: view.ordersWithoutPosition,
    caveats,
  });
}

async function toolGetPositions(): Promise<string> {
  const positions = await readPositions();
  return JSON.stringify({
    count: positions.length,
    maxPositions: getPolicy().risk.maxPositions,
    positions: positions.map(p => ({
      symbol: p.symbol,
      qty: p.qty,
      avgCost: p.avgCost,
      marketValue: p.marketValue,
      unrealizedPnL: p.unrealizedPnL,
    })),
  });
}

/**
 * Which machine event an order answers.
 *
 * The model is asked to pass the id, and when it does that is authoritative. When it does
 * not, infer only from an UNAMBIGUOUS situation: exactly one unacked event for the symbol.
 * With two open events on one symbol a guess would attribute the decision to the wrong
 * one, and a wrong link in the history is worse than no link at all.
 */
function resolveEventId(explicit: string | undefined, symbol: string): string | null {
  if (explicit) return explicit;
  // Canonical: events carry the VENUE's spelling (they are built from `TickData`), while the
  // symbol here is whatever the model typed. `===` silently found no event for `BTC/USD` and
  // returned an unlinked decision, which is the same outcome as an ambiguous match and so
  // was indistinguishable from one.
  const wanted = canonicalSymbol(symbol);
  const forSymbol = getPendingEvents().filter(e => e.symbol != null && canonicalSymbol(e.symbol) === wanted);
  return forSymbol.length === 1 ? forSymbol[0].id : null;
}

/**
 * Turn a typed refusal into a journal record and a tool result the model can read.
 *
 * A refused intent IS a decision, and the history has to hold it: without this, "why did
 * it not enter NVDA on the breakout" has no answer — the intent existed, something
 * refused it, and the only trace was a tool result that scrolled out of context.
 *
 * The two refusals are kept distinct on purpose. `veto` means this system's rules said
 * no; `rejected` means the guard allowed it and the market refused. Collapsing them would
 * make `grep '"kind":"veto"'` unable to answer what the guard actually blocked.
 *
 * Returns `null` for anything else, so an unexpected error keeps travelling up to
 * `executeTraderTool` rather than being recorded as a decision nobody made.
 */
function journalRefusal(
  err: unknown,
  fields: Partial<DecisionInput> & { rationale: string },
): string | null {
  if (err instanceof GuardRejection) {
    recordDecision(decision('veto', 'guard', { ...fields, vetoRule: err.rule, venueMessage: err.venueMessage }));
    return JSON.stringify({
      error: err.message, rejectedBy: 'guard', rule: err.rule, venueMessage: err.venueMessage,
    });
  }

  if (err instanceof BrokerRejection) {
    recordDecision(decision('rejected', 'broker', { ...fields, venueMessage: err.venueMessage }));
    // The venue's own words, verbatim and separate from the assembled message, so the
    // model has a cause to report and no reason to invent one.
    return JSON.stringify({
      error: err.message,
      rejectedBy: 'broker',
      status: err.status,
      venueCode: err.venueCode,
      venueMessage: err.venueMessage,
    });
  }

  return null;
}

/**
 * Retrofit baselines onto a position that was opened without them.
 *
 * This is the only write path for `stopLevel`, `takeProfitLevel`, `entryPrice`, and
 * `entryDecisionId` on a position that already exists. `openPositionSnapshot` refuses to
 * overwrite, and the entry flow never runs for positions that predated this system or were
 * opened by an external tool — so this goes through `upsertPositionSnapshot`, which can
 * create. It used to write through `patchPositionSnapshot`, which returns early when no
 * snapshot exists: for the externally-opened position this tool exists for, it wrote
 * nothing and still returned `{ ok: true }`.
 *
 * The stop is validated against the CURRENT price, not the entry price. An inherited
 * position can be far underwater, and every sane stop on it is then above the old entry —
 * validating against entry would reject exactly the levels worth setting.
 *
 * BEHAVIOUR CHANGE, and the one worth knowing about: this used to accept any stop below the
 * current price, in either direction, so the same tool that tightened risk could widen it. It is
 * now TIGHTEN-ONLY. A stop may be raised or restated; moving it down is refused as
 * `stop_loosened`, and the refusal is journalled with that rule name so
 * `grep '"vetoRule":"stop_loosened"'` can answer "how often did the model try to widen its risk"
 * months later. Widening a stop as a position moves against you is the mechanism by which a small
 * loss becomes a large one, and it always has a reason at the time.
 *
 * The venue stop moves with the recorded level, which is the point of the whole feature: one
 * number, in both places. It is moved AFTER the state write and its failure is reported rather
 * than thrown — the recorded level and its detector are the fallback, and losing that write over
 * a venue refusal would be the worse outcome.
 */
async function toolAnnotatePosition(input: Record<string, unknown>): Promise<string> {
  const { symbol, stopLoss, takeProfit, thesis, entryPrice } = input as {
    symbol: string; stopLoss: number; takeProfit?: number; thesis: string; entryPrice?: number;
  };

  const validated = await validateAnnotation({ symbol, stopLoss, takeProfit, thesis, entryPrice });
  if (!validated.ok) return validated.response;

  // Automation level gates stop and target moves exactly like entry and exit — no exemption
  // for "protective" tightening. `stopLoss` is always present on this tool; `takeProfit` is
  // gated separately since a call may only be touching the stop.
  const stopManual = automationLevel('stop_adjust') === 'manual';
  const targetManual = validated.takeProfit != null && automationLevel('target_adjust') === 'manual';



  // Nothing is recorded or moved yet — `actionExecutor.ts` re-validates from these exact
  // raw inputs and calls `actAnnotation` itself once a human decides.
  const action = createAction({
    kind: stopManual || !targetManual ? 'stop_adjust' : 'target_adjust',
    automatic: !stopManual && !targetManual,
    symbol: validated.symbol,
    venue: config.venue,
    params: { symbol, stopLoss, takeProfit: takeProfit ?? null, thesis, entryPrice: entryPrice ?? null },
    reason: thesis,
    timeoutMs: getPolicy().automation.timeoutMs,
  });
  return JSON.stringify({
    ok: true, pending: ['pending','approved','executing','submitted','partial','unknown'].includes(action.status), status: action.status, actionId: action.id,
    symbol: validated.symbol, stopLoss: validated.stopLoss, takeProfit: validated.takeProfit,
    note: `Adjustment queued as ${action.id}. ${action.automatic ? 'Automatic execution is enabled.' : 'Human approval is required.'} Broker confirmation will be reported separately.`,
  });
}

async function toolExecuteEntry(input: Record<string, unknown>): Promise<string> {
  const { symbol, qty, price, stopLoss, takeProfit, atr, eventId } = input as {
    symbol: string; qty: number; price: number; stopLoss: number; takeProfit: number;
    atr: number; eventId?: string;
  };
  const why = String(input.reason ?? '').trim();
  const invalidation = String(input.invalidation ?? '').trim();
  if (why.length < 20) return JSON.stringify({ ok: false, error: 'reason must say, in a sentence, why you are buying now and what measured evidence supports it.' });
  if (invalidation.length < 10) return JSON.stringify({ ok: false, error: 'invalidation is required: the condition that would mean the entry reason is no longer true.' });
  // One string so the journal, RECENT DECISIONS and the assistant all carry both halves.
  const thesis = validateThesis(input.thesis as EntryThesis, canonicalSymbol(symbol));
  const observationIds = [...new Set(thesis.premises.flatMap(p => p.evidenceIds))];
  const evidence = validateEvidenceIds(observationIds, canonicalSymbol(symbol));
  const supporting = evidence.filter(e => e.tool === 'get_position_review' && Date.now() - Date.parse(e.recordedAt) <= 15 * 60000);
  if (!supporting.length) return JSON.stringify({ ok: false, error: 'Read a fresh candidate get_position_review dossier before entering' });
  const current = supporting.at(-1)!;
  if (current.data.policyHash !== getPolicyHash()) return JSON.stringify({ ok: false, error: 'Strategy changed since the candidate dossier; refresh it' });
  if (current.data.positionKnown !== true || current.data.holding) return JSON.stringify({ ok: false, error: 'Candidate dossier must confirm that this symbol is not held' });
  const status = evaluatePremises(thesis, current.data.metrics);
  if (status.status === 'contradicted') return JSON.stringify({ ok: false, error: 'A recorded entry premise is already contradicted', thesisStatus: status });
  if (status.premises.some(p => p.metric !== 'qualitative' && p.status === 'unknown')) return JSON.stringify({ ok: false, error: 'A numeric entry premise is not currently measured', thesisStatus: status });
  const earnings = current.data.fundamentals?.calendar.daysUntil;
  if (earnings != null && earnings >= 0 && earnings <= thesis.horizonDays && !thesis.catalystRiskAccepted) return JSON.stringify({ ok: false, error: 'Earnings fall within the holding horizon; state whether that gap risk is accepted' });
  const reason = `${why} Invalidated if: ${invalidation}`;
  try {
    const result = await enterPosition({ symbol, signal: 'buy', price, stopLoss, takeProfit, atr, reason, thesis, observationIds, contextVariant: 'decision-context-v1' }, qty, resolveEventId(eventId, symbol) ?? undefined);
    return JSON.stringify({ ok: true, pending: ['pending','approved','executing','submitted','partial','unknown'].includes(result.status), symbol, ...result, note: 'Action queued. Read its status to distinguish approval, submission, and fills.' });
  } catch (err) { const refusal = journalRefusal(err, { symbol, rationale: reason, qty, price }); if (refusal) return refusal; throw err; }
}

async function toolExecuteExit(input: Record<string, unknown>): Promise<string> {
  const { symbol, basis, qty, eventId } = input as { symbol: string; basis?: ExitBasis; qty?: number; eventId?: string };
  const stated = String(input.reason ?? '').trim();
  const refuse = (error: string) => JSON.stringify({ ok: false, error });
  if (!basis || !EXIT_BASES.includes(basis)) return refuse(`basis is required: one of ${EXIT_BASES.join(', ')}.`);
  if (stated.length < 20) return refuse('reason must say, in a sentence, what changed since the last hold.');
  if (HOLD_LANGUAGE.test(stated)) return refuse('reason describes keeping the position, but execute_exit sells it. If you mean to hold, do not exit — record the hold with ack_event. If you mean to sell, state why.');
  if (basis === 'operator_request' && (agentContext.getStore()?.actorId ?? 'system') === 'system') {
    return refuse('operator_request needs an instruction from the operator. This cycle is a scheduled review; choose the basis that actually applies, or hold.');
  }
  const observationIds = input.evidenceIds as string[] | undefined;
  if (['thesis_broken','risk_reduction'].includes(basis) && !observationIds?.length) return refuse('Discretionary exits require the observation IDs showing what changed');
  if (observationIds?.length) validateEvidenceIds(observationIds, canonicalSymbol(symbol));
  const reason = `${basis.replace('_', ' ')}: ${stated}`;
  try {
    const result = await exitPosition(symbol, reason, qty, resolveEventId(eventId, symbol) ?? undefined, observationIds);
    return JSON.stringify({ ok: true, pending: ['pending','approved','executing','submitted','partial','unknown'].includes(result.status), symbol, ...result, note: 'Exit queued. Existing protection is preserved until execution.' });
  } catch (err) { const refusal = journalRefusal(err, { symbol, rationale: reason, qty }); if (refusal) return refusal; throw err; }
}


function toolGetActions(input: Record<string, unknown>): string {
  const { symbol, includeDecided } = input as { symbol?: string; includeDecided?: boolean };
  const all = includeDecided ? getAllActions() : getOpenActions();
  const filtered = symbol ? all.filter(p => sameSymbol(p.symbol, symbol)) : all;
  return JSON.stringify({
    count: filtered.length,
    actions: filtered.map(p => ({
      id: p.id,
      kind: p.kind,
      symbol: p.symbol,
      params: p.params,
      reason: p.reason,
      status: p.status,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      automatic: p.automatic,
      requestId: p.requestId,
      requestedBy: p.requestedBy,
      decidedBy: p.decidedBy,
      rejectReason: p.rejectReason,
      result: p.result,
    })),
  });
}

function toolGetPendingEvents(): string {
  return JSON.stringify({ events: getPendingEvents() });
}

/**
 * How far a given id's timestamp may sit from a pending event's before it is NOT treated as
 * a mis-copy of it. Ids are `kind:symbol:firedAt` with millisecond timestamps, and a model
 * copying 24 characters of digits does get one wrong (an observed `.842Z` for `.814Z`). Kept
 * well under the shortest gap at which the same kind+symbol can fire again — one tick, never
 * below `immutable.minTickIntervalMs` (30s) — so the near-match can only ever be the event
 * the caller was looking at, never a newer one of the same kind it has not seen yet.
 */
const ACK_ID_TOLERANCE_MS = 10_000;

/**
 * The pending event an ack id refers to: an exact match, or else the ONE pending event with
 * the same kind and symbol whose timestamp is within `ACK_ID_TOLERANCE_MS`. Anything looser
 * would let a stale id from an earlier cycle silently answer a fresh event.
 */
function resolveAckId(id: string): { id: string; symbol: string | null; corrected: boolean } | { candidates: string[] } {
  const pending = getPendingEvents();
  const exact = pending.find((e) => e.id === id);
  if (exact) return { id: exact.id, symbol: exact.symbol, corrected: false };

  // `kind:symbol:` — the timestamp after it has colons of its own, so split off two fields only.
  const m = /^([^:]+):([^:]+):(.+)$/.exec(id);
  const sameKey = m ? pending.filter((e) => e.kind === m[1] && (e.symbol ?? '-') === m[2]) : [];
  const givenAt = m ? Date.parse(m[3]) : NaN;
  const near = Number.isFinite(givenAt)
    ? sameKey.filter((e) => Math.abs(Date.parse(e.firedAt) - givenAt) <= ACK_ID_TOLERANCE_MS)
    : [];
  if (near.length === 1) return { id: near[0].id, symbol: near[0].symbol, corrected: true };
  return { candidates: sameKey.map((e) => e.id) };
}

function toolAckEvent(input: Record<string, unknown>): string {
  const { id: givenId, disposition, note, actionId } = input as {
    id: string; disposition: AckDisposition; note?: string; actionId?: string;
  };
  // Resolved before the ack: `ackEvent` deletes from `pending`, so afterwards there is no
  // event left to ask which symbol it was about.
  const resolved = resolveAckId(givenId);
  if ('candidates' in resolved) {
    // Reported rather than swallowed: a hallucinated id must not read as a handled event,
    // or the escalation ladder keeps climbing while the model believes it answered. The
    // pending ids of the same kind+symbol go back with it so a retry needs no extra call.
    return JSON.stringify({
      ok: false,
      error: 'unknown or already-acked event id',
      ...(resolved.candidates.length
        ? { pendingIdsForThisKindAndSymbol: resolved.candidates }
        : { hint: 'no pending event of this kind and symbol — it may already be acked; get_pending_events lists what is still open' }),
    });
  }
  const { id, symbol, corrected } = resolved;

  if (!ackEvent(id, disposition, note, actionId)) {
    return JSON.stringify({ ok: false, error: 'unknown or already-acked event id' });
  }

  // `acting` writes nothing: the entry or exit that follows records the same
  // `triggerEventId`, and journalling here too would count one decision twice.
  //
  // `ignoring` always writes — skipping a signal or overriding a stop is a consequential
  // non-action and must survive cycle boundaries.
  //
  // `acknowledged` only writes when the trader supplied a note AND the event has a symbol.
  // Two classes are always silent even with a note:
  //  - heartbeat events (symbol: null) — portfolio state summaries repeat the cycle
  //    context verbatim and are derived fresh every cycle; nothing to preserve.
  //  - feed/infrastructure events (data_stale, data_health) on symbols with no position —
  //    the only content is "we don't hold this", derivable from get_positions.
  // `ignoring` requires a note — fall back to a schema-valid sentinel if none supplied.
  const isHeartbeat = id.startsWith('heartbeat:');
  const shouldJournal =
    disposition === 'ignoring' ||
    (disposition === 'acknowledged' && !isHeartbeat && symbol != null && note != null && note.trim() !== '');

  if (shouldJournal) {
    recordDecision(decision('hold', 'trader', {
      symbol,
      triggerEventId: id,
      rationale: note ?? `${disposition}: no note supplied`,
    }));
  }

  logger.info(`[TraderTool] ack ${id}${corrected ? ` (given as ${givenId})` : ''} — ${disposition}${note ? `: ${note}` : ''}`);
  // Said back when corrected, so the model copies the real id next time instead of
  // learning that its mis-copy was the right one.
  return JSON.stringify(corrected
    ? { ok: true, id, disposition, correctedFrom: givenId }
    : { ok: true, id, disposition });
}

function toolGetJournal(input: Record<string, unknown>): string {
  const symbol = input.symbol as string | undefined;
  const limit = (input.limit as number | undefined) ?? 20;
  // Null fields dropped: most of a hold record is nulls, and they cost the room below.
  const records = readDecisions({ symbol, limit })
    .map(r => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)));
  // Oldest first, and the turn runner cuts an oversized result from the END — which is the
  // newest decision, the one a "why did we sell" question is about. So trim from the front
  // here, inside that bound, and say how much was trimmed.
  const BUDGET = 9000;
  let size = 0, start = records.length;
  while (start > 0 && size + JSON.stringify(records[start - 1]).length + 1 <= BUDGET) size += JSON.stringify(records[--start]).length + 1;
  const kept = records.slice(start);
  return JSON.stringify({
    count: kept.length,
    ...(start > 0 ? { omittedOlder: start, note: `The ${start} oldest of ${records.length} records were left out to fit; pass symbol or a smaller limit to see them.` } : {}),
    decisions: kept,
  });
}

/**
 * Reads only. No network: both inputs are local append-only files, so this costs nothing
 * and can be called mid-cycle without a market-data budget.
 */
function toolGetScorecard(input: Record<string, unknown>): string {
  return JSON.stringify(scorecard({
    symbol: input.symbol as string | undefined,
    days: input.days as number | undefined,
  }));
}

/**
 * The other half of `get_scorecard`, and the reason that one now carries a caveat pointing
 * here: absolute trade statistics cannot say whether the trading beat sitting in the index.
 *
 * Unlike its neighbour this DOES hit the network — the broker's portfolio history and a SPY
 * daily series — so it is a market-data call and not a free local read.
 */
async function toolGetBenchmark(input: Record<string, unknown>): Promise<string> {
  return JSON.stringify(await benchmark({ days: input.days as number | undefined }));
}

/** `get_benchmark`'s single-symbol sibling — one price series, no account leg. */
async function toolGetPriceStats(input: Record<string, unknown>): Promise<string> {
  return JSON.stringify(await symbolStats(String(input.symbol ?? ''), { days: input.days as number | undefined }));
}

/**
 * The write half of the adaptation loop, and the only tool whose effect is on a FUTURE
 * cycle rather than this one.
 *
 * Deliberately unguarded beyond "not empty": there is no rate limit and no dedup, so the
 * bar is prose in PLAYBOOK.md and the tool description. A mechanical gate here would have to
 * decide when a conclusion is allowed to occur, and the moment a lesson is worth writing is
 * the moment its evidence is in context — not a time of day. If the file starts growing
 * every cycle that is visible in `data/LESSONS.md` on the first read.
 */
function toolWriteLesson(input: Record<string, unknown>): string {
  const lesson = recordLesson(String(input.lesson ?? ''), input.evidenceIds as string[] ?? [], { counterEvidenceIds: input.counterEvidenceIds as string[] | undefined, reviewAfter: input.reviewAfter as string | undefined, scope: input.scope as string | undefined });
  return JSON.stringify({
    ok: true,
    stored: lesson,
    note: 'Saved as an advisory observation; the operator can edit or retire it in Lessons.',
  });
}
