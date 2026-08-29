import { broker } from '../broker';
import { BrokerRejection } from '../broker/errors';
import { GuardRejection, enterPosition, exitPosition } from '../strategy/orderManager';
// Only the reporting predicate remains here. The rules that *refuse* an order moved below
// the decision maker, into `enterPosition`, where a second caller cannot skip them.
import { isDailyLossBreached } from '../strategy/riskManager';
import { etNow } from '../core/time';
import { ackEvent, getPendingEvents, type AckDisposition } from '../features/eventBus';

import { RESEARCH_TOOL_DEFINITIONS, executeResearchTool } from './researchTools';
import {
  ALPACA_DATA_TOOL_DEFINITIONS,
  ALPACA_DATA_TOOL_NAMES,
  executeAlpacaDataTool,
} from './alpacaDataTools';
import { getRegime } from '../macro/regime';
import { volatilityScaledQty, correlationGate } from '../strategy/portfolioRisk';
import { exposure } from '../strategy/exposure';
import { getFundamentals } from '../collect/fundamentals';
import { collectBars, DEFAULT_COLLECT_REQUEST } from '../collect';
import { isPresent } from '../collect/types';
import { atr } from '../strategy/indicators';
import { computeSignals, signalSummary, signalTally } from '../strategy/signals';
import { reversalFilter } from '../strategy/reversal';
import { getLastTick } from '../features/lastTick';
import { watchlistScan } from '../features/watchlistScan';
import {
  getPositionSnapshot,
  getState,
  openPositionSnapshot,
  upsertPositionSnapshot,
  removePositionSnapshot,
} from '../state/state';
import { canonicalSymbol, isCryptoSymbol, sameSymbol } from '../core/symbols';
import { canTighten, moveStopTo, type ArmResult } from '../strategy/stopOrders';
import { decision, readDecisions, recordDecision } from '../journal/journal';
import { recordLesson } from '../journal/lessons';
import { scorecard } from '../review/metrics';
import type { DecisionInput } from '../journal/types';
import { getPolicy } from '../policy/load';
import { logger } from '../core/logger';
import type { ToolDefinition, SignalResult } from '../core/types';
import type { OpenOrder } from '../broker/IBroker';

// ── Tool definitions ──────────────────────────────────────────────────────────

export const TRADER_TOOL_DEFINITIONS: ToolDefinition[] = [
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
    description: 'Read the orders actually resting at the venue right now, grouped by position. This system places market orders and protective sell stops; a stop whose orderId matches the position\'s stopOrderIdRecordedHere is its own, and anything else was placed outside it. Two separate facts per position: stopLevelRecordedHere is the level the stop detector watches while this process runs, venueStop is the order that protects the position when it is not. Use this to answer "is there a stop on my positions, and where" instead of assuming either way.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'execute_entry',
    description: 'Buy at market. The stop is recorded as YOUR baseline AND placed at the venue as a real resting GTC sell stop, so the position stays protected while this process is not running — which means the stop can fill on its own, without an execute_exit call. The target is recorded only and is not sent anywhere. The result reports under venueStop whether the stop actually rests at the venue, and why not when it does not (crypto cannot have one; a fill that did not confirm in time is retried by the stop sweep). Risk rules (max positions, buying power, daily loss limit) are enforced and return an error if violated. The filled qty may be smaller than requested if the macro regime caps it; the result reports what was actually bought.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        qty: { type: 'number', description: 'Number of shares to buy.' },
        price: { type: 'number', description: 'Current/expected entry price.' },
        stopLoss: { type: 'number', description: 'Absolute stop-loss price. A real sell stop is placed at the venue at this level, so choose it as a price you are content to be sold at unattended, not as a rough marker.' },
        takeProfit: { type: 'number', description: 'Absolute take-profit price.' },
        atr: { type: 'number', description: 'ATR at entry. Recorded as the baseline the stop was sized against.' },
        reason: { type: 'string', description: 'One-sentence reason for the entry.' },
        eventId: { type: 'string', description: 'Optional — the MACHINE EVENTS id this entry answers, verbatim. Links the decision to what prompted it.' },
      },
      required: ['symbol', 'qty', 'price', 'stopLoss', 'takeProfit', 'atr', 'reason'],
    },
  },
  {
    name: 'annotate_position',
    description: 'Set or tighten the stop, target and thesis on a position — one opened without them (legacy or external holdings, anything showing NO STOP RECORDED HERE) or one whose stop you now want raised. Writes the stop into the state so the stop detector begins watching it immediately, AND moves the real sell stop resting at the venue to match, so the level holds while this process is not running. TIGHTEN-ONLY: a stop can be raised or restated, never widened — a lower stop is refused as stop_loosened. If the thesis has changed enough that the old stop is wrong, exit rather than giving the position more room. Records a hold decision in the journal so the thesis survives cycle boundaries.',
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
    description: 'Close an open position at market price.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        reason: { type: 'string', description: 'Reason for exiting the position.' },
        eventId: { type: 'string', description: 'Optional — the MACHINE EVENTS id this exit answers, verbatim. Links the decision to what prompted it.' },
      },
      required: ['symbol', 'reason'],
    },
  },
  {
    name: 'get_pending_events',
    description: 'Read the full evidence for every machine event that has fired and not been acked. The MACHINE EVENTS block in the cycle context is a summary of these; call this for the numbers behind a headline.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ack_event',
    description: 'Mark a machine event answered so it stops escalating. Call it for every event you deal with, including ones you decide to ignore.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The event id, verbatim from MACHINE EVENTS or get_pending_events.' },
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
    name: 'write_lesson',
    description: 'Record ONE changed rule of thumb, in prose, for every future cycle to read. This is the only thing you can say that outlives this cycle — the context you are given is rebuilt from scratch next time, so a conclusion you do not write here is lost. Write one only when something actually taught you a rule: "XLE gapped on an OPEC headline nobody checked, so energy entries need a scheduled-events check" is a lesson; "the tape was choppy" is noise, and restating a rule already in your policy is noise. Most cycles must add nothing, and that is the correct outcome. Name the evidence inside the text — a scorecard number, a round trip, a veto you hit.',
    input_schema: {
      type: 'object',
      properties: {
        lesson: {
          type: 'string',
          description: 'The lesson in prose: what happened, what it generalizes to, and what you will do differently. Markdown is fine.',
        },
      },
      required: ['lesson'],
    },
  },
  {
    name: 'get_macro_regime',
    description: 'Classify the current macro regime (expansion, late_cycle, recession, recovery) based on GDP growth, unemployment, CPI, yield curve, and VIX from FRED. Cached for 6h. Use this to condition entry aggressiveness: tighten in late_cycle/recession, widen in expansion/recovery.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_position_size',
    description: 'Compute a volatility-scaled position size for a symbol. Uses inverse-ATR sizing so high-volatility names get fewer shares (equal risk per position). Call this BEFORE execute_entry to determine qty.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol.' },
        price: { type: 'number', description: 'Current/expected entry price.' },
        atr: { type: 'number', description: 'Current ATR for the symbol.' },
      },
      required: ['symbol', 'price', 'atr'],
    },
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
    description: 'Read the WHOLE watchlist as one table: every non-held watchlist symbol with its five signal scores, tally (including composite, their mean), the reversal filter, ATR, RSI, both EMAs, price and price staleness. Use this INSTEAD of calling get_signals once per symbol when you are scanning for a candidate — it is one call rather than eighteen, and the numbers are identical because both come from the same deterministic computation. These are the exact figures the machine judged on its last 60-second pass, not a fresh fetch: tickAt and ageMs say when, and a caveat appears if the table is older than a few tick intervals. Held names are NOT rows — they are listed in heldExcluded, so their absence means held, not off the watchlist. A symbol the machine declined to score (too little bar history) is still a row, with notScored naming why, so silence never stands in for missing data. priceStale is about the PRICE only; signals come from bars, so a row can have no price and full scores. Rows are SORTED by composite descending, which is an ordering and not a judgement of quality; unscored rows sort last. The five signals are one trend family and correlated, so read composite rather than counting votes, and read reversal separately — it is the only reading here that can disagree with them. Before the first tick of a process there is no table at all and this returns an error rather than an empty list. For a symbol that is not on the watchlist, or for a fresh reading right now, use get_signals(symbol).',
    input_schema: {
      type: 'object',
      properties: {},
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
    description: 'Schedule the next trader cycle. MUST be the final tool call of every cycle. This is a MAXIMUM silence, not a polling interval — the machine watches every 60 seconds and wakes you when something crosses, so a short sleep costs a full cycle and tells you nothing new. Market open: 60. Market closed: 240. Do NOT use 10 when the market is closed — that wastes cycles and burns tokens for no reason.',
    input_schema: {
      type: 'object',
      properties: {
        minutes: {
          type: 'number',
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

export async function executeTraderTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  try {
    switch (name) {
      case 'get_market_status':   return await toolGetMarketStatus();
      case 'get_account':         return await toolGetAccount();
      case 'get_positions':       return await toolGetPositions();
      case 'get_open_orders':     return await toolGetOpenOrders();
      case 'get_macro_regime':    return await toolGetMacroRegime();
      case 'get_position_size':   return await toolGetPositionSize(input);
      case 'get_signals':         return await toolGetSignals(input);
      case 'get_watchlist_scan':  return toolGetWatchlistScan();
      case 'get_correlation':     return await toolGetCorrelation(input);
      case 'get_exposure':        return await toolGetExposure();
      case 'get_calendar':        return await toolGetCalendar(input);
      case 'get_fundamentals':    return await toolGetFundamentals(input);
      case 'execute_entry':       return await toolExecuteEntry(input);
      case 'annotate_position':   return await toolAnnotatePosition(input);
      case 'execute_exit':        return await toolExecuteExit(input);
      case 'get_pending_events':  return toolGetPendingEvents();
      case 'ack_event':           return toolAckEvent(input);
      case 'get_journal':         return toolGetJournal(input);
      case 'get_scorecard':       return toolGetScorecard(input);
      case 'write_lesson':        return toolWriteLesson(input);
      // No `sleep` case: trader.ts intercepts it before dispatch (it sets the next cycle
      // delay, which only the agent loop can do), and it is not a concierge tool.
      default:
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
      return JSON.stringify({ error: err.message, rejectedBy: 'guard', rule: err.rule });
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

// ── Implementations ───────────────────────────────────────────────────────────

async function toolGetMarketStatus(): Promise<string> {
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

  return JSON.stringify({
    isOpen,
    etTime: timeStr,
    utcTime: new Date().toISOString(),
    isWeekend,
    minutesUntilChange,
    changeLabel,
  });
}

async function toolGetMacroRegime(): Promise<string> {
  const regime = await getRegime();
  return JSON.stringify(regime);
}

async function toolGetPositionSize(input: Record<string, unknown>): Promise<string> {
  const { symbol, price, atr } = input as { symbol: string; price: number; atr: number };
  const account = await broker.getAccountInfo();
  const policy = getPolicy();

  const recommendedQty = volatilityScaledQty(account.equity, price, atr);
  const flatQty = Math.floor(account.equity * policy.risk.positionSizePct / price);
  const riskPerShare = atr * policy.risk.stopLossAtrMult;
  const dollarRisk = recommendedQty * riskPerShare;

  return JSON.stringify({
    symbol,
    recommendedQty,
    flatQty,
    // Three outcomes, not two. `recommendedQty === 0` means one share does not fit the
    // risk budget at all, and the old two-branch string reported that as "ATR is low ->
    // more shares within budget" — the exact opposite, handed to the model as a premise.
    reason: recommendedQty === 0
      ? `Does not fit: one share risks $${riskPerShare.toFixed(2)}, above the whole $${(account.equity * policy.risk.positionSizePct).toFixed(2)} budget for this position`
      : recommendedQty < flatQty
        ? `Vol-scaled: ATR $${atr.toFixed(2)} is high → fewer shares for equal risk`
        : `Vol-scaled: ATR $${atr.toFixed(2)} is low → more shares within budget`,
    riskPerShare: parseFloat(riskPerShare.toFixed(2)),
    totalDollarRisk: parseFloat(dollarRisk.toFixed(2)),
    notional: parseFloat((recommendedQty * price).toFixed(2)),
    equity: account.equity,
  });
}

/**
 * The five signal scores for one symbol, plus their composite and the reversal filter.
 *
 *
 * Until this existed, signals could ONLY reach the trader as `evidence.signals` on an
 * `entry_signal` event — which fires on an EMA cross, not on being asked about. A
 * discretionary scan ("enter the best setup on the watchlist") therefore had no way to
 * obtain them, and the rationale it wrote named signals it had never seen, using the
 * five names POLICY.md lists.
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
    reversal: reversalFilter(bars.value, marketCap),
    summary: signalSummary(signals),
    caveats: [
      'The five signals all measure trend and are highly correlated, so their counts inflate: a 5/5 tally is closer to one confirmation counted five times. tally.composite is their mean and is the number to threshold on.',
      'reversal is NOT in the composite. Its score reads the opposite way to a signal score — negative means the name has already run — and it answers "is this too late to chase" over about a month, not "is this a good entry today".',
    ],
  });
}

/**
 * The watchlist as one table, read out of the tick that already computed it.
 *
 * Sync, and reaches nothing: no broker call, no network, no promise. The whole point is
 * that the numbers were computed a few seconds ago by `collectAndCompute` and then thrown
 * away. `get_signals` had to re-fetch bars per symbol to rebuild them, so a discretionary
 * pass over eighteen names spent eighteen of thirty rounds rebuilding a table that had been
 * in memory — which is why POLICY.md's "assess watchlist candidates" step was unfollowable
 * as written, and an unfollowable instruction is a fabrication vector.
 *
 * Thin on purpose. The projection lives in `features/watchlistScan.ts`, beside the tick it
 * reads; nothing here rounds, sorts or decides. `get_signals` stays for the two things this
 * cannot do: a symbol that is not on the watchlist, and a reading taken right now.
 */
function toolGetWatchlistScan(): string {
  return JSON.stringify(watchlistScan(getLastTick(), getPolicy().triggers.tickIntervalMs));
}

async function toolGetCorrelation(input: Record<string, unknown>): Promise<string> {
  const { symbol } = input as { symbol: string };
  const result = await correlationGate(symbol);
  return JSON.stringify({
    symbol,
    maxCorrelation: parseFloat(result.maxCorrelation.toFixed(3)),
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
    maxHeldCorrelation: r(e.maxHeldCorrelation, 3),
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
    source: f.source,
    caveats: f.caveats,
  });
}

async function toolGetAccount(): Promise<string> {
  const account = await broker.getAccountInfo();
  const risk = getPolicy().risk;

  // The daily reset used to happen HERE, on the first account call of each day, which made
  // the baseline of the daily loss limit depend on whether the model chose to call a tool.
  // It is now `ensureDailyReset()` at the top of every scheduler tick — deterministic, and
  // keyed off the ET date rather than the UTC one.
  const startEquity = getState().startOfDayEquity || account.equity;
  const dailyPnL = account.equity - startEquity;
  const dailyPnLPct = startEquity > 0 ? (dailyPnL / startEquity) * 100 : 0;
  const lossLimitBreached = isDailyLossBreached(account, startEquity);

  return JSON.stringify({
    equity: account.equity,
    cash: account.cash,
    buyingPower: account.buyingPower,
    startOfDayEquity: startEquity,
    dailyPnL: parseFloat(dailyPnL.toFixed(2)),
    dailyPnLPct: parseFloat(dailyPnLPct.toFixed(2)),
    lossLimitPct: risk.maxDailyLossPct * 100,
    lossLimitBreached,
    maxPositions: risk.maxPositions,
  });
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
  'This system places market orders and protective sell stops. A stop whose orderId matches the position\'s stopOrderIdRecordedHere is this system\'s own, placed from the recorded stopLevel; any other order listed here was placed outside this system. The two facts stay separate on purpose: stopLevelRecordedHere is what the stop detector compares the price against while this process runs, and venueStop is what protects the position when it is not running. Crypto can have no venue stop at all — the venue rejects a plain stop on a coin.';

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
    broker.getOpenOrders(),
    broker.getPositions(),
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
  const positions = await broker.getPositions();
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
    recordDecision(decision('veto', 'guard', { ...fields, vetoRule: err.rule }));
    return JSON.stringify({ error: err.message, rejectedBy: 'guard', rule: err.rule });
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
  const { symbol, stopLoss, takeProfit, thesis } = input as {
    symbol: string; stopLoss: number; takeProfit?: number; thesis: string; entryPrice?: number;
  };
  const providedEntryPrice = input.entryPrice as number | undefined;

  // Confirm the position is live at the venue — annotating a phantom is worse than
  // doing nothing, because it creates a stop the detector will report on air.
  const positions = await broker.getPositions();
  // `sameSymbol`, not `===`: the model quotes the symbol as the portfolio renders it, which
  // for crypto is the snapshot's `BTC/USD` against the venue's `BTCUSD`. An exact match
  // reported "no open position" for a position sitting right there in the same context.
  const held = positions.find(p => sameSymbol(p.symbol, symbol));
  if (!held) {
    return JSON.stringify({ error: `No open position in ${symbol} at the venue — nothing to annotate` });
  }

  // Entry price: the snapshot if it has one, else the caller's, else the venue's cost
  // basis. The venue fallback is why this can no longer fail for want of a number the
  // broker already told us.
  const snap = getPositionSnapshot(symbol);
  const effectiveEntry = snap?.entryPrice ?? providedEntryPrice ?? held.avgCost;

  // Same shape as toolExecuteExit's exit price. Degrades to the cost basis when the broker
  // omits marketValue, which is the pre-existing convention for "no better number".
  const currentPrice = (held.marketValue ?? held.avgCost * held.qty) / held.qty;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return JSON.stringify({ error: `Cannot determine a current price for ${symbol} — refusing to set a stop against an unknown level` });
  }

  if (!(stopLoss > 0 && stopLoss < currentPrice)) {
    return JSON.stringify({
      error: stopLoss >= currentPrice
        ? `stopLoss $${stopLoss} is at or above the current price $${currentPrice.toFixed(2)} — that level is already breached, use execute_exit if you want out`
        : `stopLoss $${stopLoss} must be above zero and below the current price $${currentPrice.toFixed(2)}`,
    });
  }
  if (takeProfit != null && takeProfit <= currentPrice) {
    return JSON.stringify({ error: `takeProfit $${takeProfit} must be above the current price $${currentPrice.toFixed(2)}` });
  }

  // Tighten-only. `canTighten` is shared with the stop sweep so the tool and the repair pass
  // cannot come to different conclusions about what counts as loosening.
  //
  // Journalled as a veto with a machine-readable rule, exactly like the guards in
  // `orderManager`, because the interesting question is not this one refusal — it is the pattern
  // across a month.
  if (!canTighten(snap?.stopLevel, stopLoss)) {
    recordDecision(decision('veto', 'guard', {
      symbol,
      rationale: thesis,
      vetoRule: 'stop_loosened',
      intendedStop: stopLoss,
      price: currentPrice,
    }));
    return JSON.stringify({
      error: `stopLoss $${stopLoss} is below the stop already recorded for ${symbol} ($${snap!.stopLevel}). `
        + `Stops are tighten-only: they can be raised or restated, never widened. If the thesis has `
        + `changed enough that the old stop is wrong, exit the position rather than giving it more room.`,
      rejectedBy: 'guard',
      rule: 'stop_loosened',
      recordedStop: snap!.stopLevel,
    });
  }

  // Record a hold decision: this becomes the entryDecisionId the portfolio context resolves
  // as the thesis, so "rationale not recorded" is replaced by the supplied text next cycle.
  const record = recordDecision(decision('hold', 'trader', {
    symbol,
    rationale: thesis,
    triggerEventId: null,
    executed: false,
    qty: null,
    price: effectiveEntry,
    intendedStop: stopLoss,
    intendedTarget: takeProfit ?? null,
    atrAtEntry: null,
    orderId: null,
  }));

  // Write baselines. entryPrice only if it was missing — the ownership invariant from
  // openPositionSnapshot: entry baselines are written once and never overwritten.
  upsertPositionSnapshot(symbol, {
    stopLevel: stopLoss,
    ...(takeProfit != null && { takeProfitLevel: takeProfit }),
    ...(snap?.entryPrice == null && { entryPrice: effectiveEntry }),
    entryDecisionId: record.id,
  });

  // Read the write back. The bug this replaces was a success report with no write behind
  // it, so the report is now conditional on the state actually holding the level.
  const written = getPositionSnapshot(symbol);
  if (written?.stopLevel !== stopLoss) {
    return JSON.stringify({ error: `Failed to record the stop for ${symbol} — state still shows ${written?.stopLevel ?? 'no stop'}` });
  }

  // Now make the venue agree. `moveStopTo` replaces a resting stop rather than cancelling and
  // re-placing it — cancel-then-place would leave a window with no protection at all — and arms
  // one if none rests, which covers an inherited position being annotated for the first time.
  const venueStop = isCryptoSymbol(symbol)
    ? { ok: false as const, reason: `${symbol} is a crypto pair and the venue rejects a plain stop on a coin, so no stop can rest there.` }
    : await moveStopTo(symbol, held.qty, stopLoss);

  return JSON.stringify({
    ok: true, symbol, stopLevel: stopLoss, takeProfitLevel: takeProfit ?? null,
    entryPrice: effectiveEntry, entryDecisionId: record.id,
    venueStop: venueStop.ok
      ? { orderId: venueStop.orderId, note: `The stop resting at the venue is now $${stopLoss}, so this level holds while this process is not running.` }
      : { orderId: null, note: `The level is recorded and the breach detector is watching it, but the venue stop was NOT moved: ${venueStop.reason} Until the stop sweep succeeds, this level only holds while this process runs.` },
  });
}

async function toolExecuteEntry(input: Record<string, unknown>): Promise<string> {
  const { symbol, qty, price, stopLoss, takeProfit, atr, reason, eventId } = input as {
    symbol: string; qty: number; price: number;
    stopLoss: number; takeProfit: number; atr: number; reason: string; eventId?: string;
  };

  const triggerEventId = resolveEventId(eventId, symbol);
  const signal: SignalResult = { symbol, signal: 'buy', reason, price, atr, stopLoss, takeProfit };

  // Every risk rule now lives inside `enterPosition`, below this tool, where no caller
  // can skip it.
  // `filledQty`, not `qty`: the guard's regime sizing can cut the request, and journalling
  // the number the model asked for would record a position that was never opened.
  let orderId: string;
  let filledQty: number;
  let venueStop: ArmResult;
  try {
    ({ orderId, qty: filledQty, venueStop } = await enterPosition(signal, qty));
  } catch (err) {
    const refusal = journalRefusal(err, {
      symbol,
      rationale: reason,
      triggerEventId,
      qty: qty ?? null,
      price: price ?? null,
      intendedStop: stopLoss ?? null,
      intendedTarget: takeProfit ?? null,
      atrAtEntry: atr ?? null,
    });
    if (refusal) return refusal;
    throw err;
  }

  // Journalled BEFORE the snapshot, because the snapshot stores the record's id: the
  // position and the decision that opened it are linked from the moment both exist.
  const record = recordDecision(decision('entry', 'trader', {
    symbol,
    rationale: reason,
    triggerEventId,
    executed: true,
    qty: filledQty,
    price,
    intendedStop: stopLoss,
    intendedTarget: takeProfit,
    atrAtEntry: atr,
    orderId,
    // The only durable account of whether the position is actually protected at the venue. The
    // tool result below says the same thing, but the model reads that once and the cycle ends;
    // this answers "why did that position sit naked until the sweep found it" a week later.
    venueStopId: venueStop.ok ? venueStop.orderId : null,
    venueStopMissing: venueStop.ok ? null : venueStop.reason,
  }));

  // The one write, which is why `enterPosition` returns the stop's id instead of recording it
  // itself: until this call runs there is no snapshot to patch.
  openPositionSnapshot({
    symbol,
    entryPrice: price,
    sessionHigh: price,
    sessionLow: price,
    stopLevel: stopLoss,
    takeProfitLevel: takeProfit,
    openedAt: record.at,
    entryDecisionId: record.id,
    ...(venueStop.ok && { stopOrderId: venueStop.orderId }),
  });

  return JSON.stringify({
    ok: true, symbol, qty: filledQty, requestedQty: qty,
    price, stopLoss, takeProfit, decisionId: record.id,
    // Whether the stop is only a level here or also an order at the venue, and WHY when it is
    // only a level. A quiet `null` would read as "no stop", which is wrong — the level is
    // recorded and watched either way — and an unexplained one invites a guess.
    venueStop: venueStop.ok
      ? { orderId: venueStop.orderId, level: stopLoss, note: 'A real sell stop rests at the venue at this level, so the position is protected while this process is not running.' }
      : { orderId: null, level: stopLoss, note: `No stop rests at the venue: ${venueStop.reason} The recorded level is still watched by the breach detector, but only while this process runs.` },
  });
}

/**
 * Close a position.
 *
 * Order matters: confirm there is something to sell, sell it, record it, and only then
 * discard the baselines. The previous order removed the snapshot before knowing the sell
 * had happened, so a no-op or a venue rejection destroyed `entryPrice`, `stopLevel`,
 * `sessionHigh` and `openedAt` for a position that was still open — and still returned
 * `{ ok: true }`.
 */
async function toolExecuteExit(input: Record<string, unknown>): Promise<string> {
  const { symbol, reason, eventId } = input as {
    symbol: string; reason: string; eventId?: string;
  };

  const triggerEventId = resolveEventId(eventId, symbol);

  // Read before the sell, not as a pre-check — `exitPosition`'s `no_position` guard owns
  // that — but because once the sell fills the broker stops reporting the position, and
  // the P&L the record needs goes with it.
  // `sameSymbol`, like `toolAnnotatePosition` — `===` missed a `BTCUSD` position asked for
  // as `BTC/USD`, so the exit record carried `qty: null, price: null, pnl: null` for a sell
  // that had gone through.
  const held = (await broker.getPositions()).find(p => sameSymbol(p.symbol, symbol));

  let orderId: string;
  // Resting sell orders this exit had to cancel to free the shares — which now includes THIS
  // SYSTEM'S OWN stop, since the position was protected at the venue. Reported back because the
  // model is the only thing that can act on it: if the sell somehow leaves a remainder held,
  // nothing at the venue is watching it any more, and a hand-placed order cancelled alongside
  // ours is not put back by anything (only ours is, and only if the sell itself fails).
  let cancelled: string[] = [];
  try {
    ({ orderId, cancelled } = await exitPosition(symbol, reason));
  } catch (err) {
    const refusal = journalRefusal(err, {
      symbol,
      rationale: reason,
      triggerEventId,
      qty: held?.qty ?? null,
      pnl: held?.unrealizedPnL ?? null,
    });
    if (refusal) return refusal;
    throw err;
  }

  // `exitPosition` throws `no_position` when there is nothing to sell, so reaching here
  // means the position existed and the order was accepted.
  //
  // `held` was read before the sell and is the best source for qty, P&L and exit price.
  // In the rare race where a fill beat the pre-read (position already gone from the
  // broker's book), fall back to the snapshot for qty and mark price/pnl as unknown —
  // the record still lands and the snapshot is still removed.
  const qty       = held?.qty ?? null;
  const pnl       = held?.unrealizedPnL ?? null;
  const exitPrice = held
    ? (held.marketValue ?? held.avgCost * held.qty) / held.qty
    : null;

  const record = recordDecision(decision('exit', 'trader', {
    symbol,
    rationale: reason,
    triggerEventId,
    executed: true,
    qty,
    price: exitPrice,
    pnl,
    orderId,
  }));
  removePositionSnapshot(symbol);

  return JSON.stringify({
    ok: true, symbol, qty, price: exitPrice,
    pnl, reason, decisionId: record.id,
    ...(cancelled.length > 0 ? { cancelledOrders: cancelled } : {}),
  });
}

function toolGetPendingEvents(): string {
  const events = getPendingEvents();
  return JSON.stringify({
    count: events.length,
    events: events.map(e => ({
      id: e.id,
      kind: e.kind,
      severity: e.severity,
      symbol: e.symbol,
      firedAt: e.firedAt,
      headline: e.headline,
      evidence: e.evidence,
      suggestedAction: e.suggestedAction,
      wakeCount: e.wakeCount,
      policyVersion: e.policyVersion,
    })),
  });
}

function toolAckEvent(input: Record<string, unknown>): string {
  const { id, disposition, note } = input as {
    id: string; disposition: AckDisposition; note?: string;
  };
  // Read before the ack: `ackEvent` deletes from `pending`, so afterwards there is no
  // event left to ask which symbol it was about.
  const symbol = getPendingEvents().find(e => e.id === id)?.symbol ?? null;

  if (!ackEvent(id, disposition, note)) {
    // Reported rather than swallowed: a hallucinated id must not read as a handled event,
    // or the escalation ladder keeps climbing while the model believes it answered.
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

  logger.info(`[TraderTool] ack ${id} — ${disposition}${note ? `: ${note}` : ''}`);
  return JSON.stringify({ ok: true, id, disposition });
}

function toolGetJournal(input: Record<string, unknown>): string {
  const symbol = input.symbol as string | undefined;
  const limit = (input.limit as number | undefined) ?? 20;
  const records = readDecisions({ symbol, limit });
  return JSON.stringify({ count: records.length, decisions: records });
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
 * The write half of the adaptation loop, and the only tool whose effect is on a FUTURE
 * cycle rather than this one.
 *
 * Deliberately unguarded beyond "not empty": there is no rate limit and no dedup, so the
 * bar is prose in POLICY.md and the tool description. A mechanical gate here would have to
 * decide when a conclusion is allowed to occur, and the moment a lesson is worth writing is
 * the moment its evidence is in context — not a time of day. If the file starts growing
 * every cycle that is visible in `data/LESSONS.md` on the first read.
 */
function toolWriteLesson(input: Record<string, unknown>): string {
  const lesson = recordLesson(String(input.lesson ?? ''));
  return JSON.stringify({
    ok: true,
    stored: lesson,
    note: 'Every future cycle will read this until an operator deletes it.',
  });
}
