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
import { collectBars, DEFAULT_COLLECT_REQUEST } from '../collect';
import { isPresent } from '../collect/types';
import { atr } from '../strategy/indicators';
import { computeSignals, signalSummary } from '../strategy/signals';
import {
  getState,
  openPositionSnapshot,
  removePositionSnapshot,
} from '../state/state';
import { decision, readDecisions, recordDecision } from '../journal/journal';
import { recordLesson } from '../journal/lessons';
import { scorecard } from '../review/metrics';
import type { DecisionInput } from '../journal/types';
import { getPolicy } from '../policy/load';
import { logger } from '../core/logger';
import type { ToolDefinition, SignalResult } from '../core/types';

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
    name: 'execute_entry',
    description: 'Buy at market. The stop and target are recorded as YOUR baselines and watched by this system, not sent to the venue as bracket legs — nothing exits the position but an execute_exit call. Risk rules (max positions, buying power, daily loss limit) are enforced and return an error if violated. The filled qty may be smaller than requested if the macro regime caps it; the result reports what was actually bought.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        qty: { type: 'number', description: 'Number of shares to buy.' },
        price: { type: 'number', description: 'Current/expected entry price.' },
        stopLoss: { type: 'number', description: 'Absolute stop-loss price.' },
        takeProfit: { type: 'number', description: 'Absolute take-profit price.' },
        atr: { type: 'number', description: 'ATR at entry. Recorded as the baseline the stop was sized against.' },
        reason: { type: 'string', description: 'One-sentence reason for the entry.' },
        eventId: { type: 'string', description: 'Optional — the MACHINE EVENTS id this entry answers, verbatim. Links the decision to what prompted it.' },
      },
      required: ['symbol', 'qty', 'price', 'stopLoss', 'takeProfit', 'atr', 'reason'],
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
        note: { type: 'string', description: 'One sentence: why this disposition.' },
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
    description: 'Compute the five entry signals — EMA Momentum, Trend Strength, Volume, Breakout, MACD — for any symbol, each scored -1 (strongly bearish) to +1 (strongly bullish), plus ATR and the last close. This is the SAME deterministic computation that fills the signal evidence on an entry_signal event, run on demand: use it for a candidate that has not fired an event, so a signal breakdown you report is one you actually measured. Never state which signals are bullish or bearish without this tool or get_pending_events.',
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
    name: 'sleep',
    description: 'Schedule the next trader cycle. MUST be the final tool call of every cycle. This is a MAXIMUM silence, not a polling interval — the machine watches every 60 seconds and wakes you when something crosses, so a short sleep costs a full cycle and tells you nothing new. Market open: 60. Market closed: 240.',
    input_schema: {
      type: 'object',
      properties: {
        minutes: {
          type: 'number',
          description: 'Maximum minutes of silence before the next cycle. 60 while the market is open, 240 while it is closed.',
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
      case 'get_macro_regime':    return await toolGetMacroRegime();
      case 'get_position_size':   return await toolGetPositionSize(input);
      case 'get_signals':         return await toolGetSignals(input);
      case 'get_correlation':     return await toolGetCorrelation(input);
      case 'get_exposure':        return await toolGetExposure();
      case 'execute_entry':       return await toolExecuteEntry(input);
      case 'execute_exit':        return await toolExecuteExit(input);
      case 'get_pending_events':  return toolGetPendingEvents();
      case 'ack_event':           return toolAckEvent(input);
      case 'get_journal':         return toolGetJournal(input);
      case 'get_scorecard':       return toolGetScorecard(input);
      case 'write_lesson':        return toolWriteLesson(input);
      case 'sleep':               return JSON.stringify({ ok: true, nextCycleIn: `${input.minutes} min` });
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
    reason: recommendedQty < flatQty
      ? `Vol-scaled: ATR $${atr.toFixed(2)} is high → fewer shares for equal risk`
      : `Vol-scaled: ATR $${atr.toFixed(2)} is low → more shares within budget`,
    riskPerShare: parseFloat(riskPerShare.toFixed(2)),
    totalDollarRisk: parseFloat(dollarRisk.toFixed(2)),
    notional: parseFloat((recommendedQty * price).toFixed(2)),
    equity: account.equity,
  });
}

/**
 * The five signal scores for one symbol, on demand.
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

  return JSON.stringify({
    symbol,
    asOf: bars.asOf,
    timeframe: DEFAULT_COLLECT_REQUEST.timeframe,
    bars: bars.value.length,
    lastClose: lastBar.c,
    atr: atrSeries.length > 0 ? parseFloat(atrSeries[atrSeries.length - 1].toFixed(2)) : null,
    signals,
    summary: signalSummary(signals),
  });
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
  const forSymbol = getPendingEvents().filter(e => e.symbol === symbol);
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
  try {
    ({ orderId, qty: filledQty } = await enterPosition(signal, qty));
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
  }));

  openPositionSnapshot({
    symbol,
    entryPrice: price,
    sessionHigh: price,
    sessionLow: price,
    stopLevel: stopLoss,
    takeProfitLevel: takeProfit,
    openedAt: record.at,
    entryDecisionId: record.id,
  });

  return JSON.stringify({
    ok: true, symbol, qty: filledQty, requestedQty: qty,
    price, stopLoss, takeProfit, decisionId: record.id,
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
  const held = (await broker.getPositions()).find(p => p.symbol === symbol);

  let orderId: string;
  try {
    ({ orderId } = await exitPosition(symbol, reason));
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
  const pos = held!;
  const exitPrice = (pos.marketValue ?? pos.avgCost * pos.qty) / pos.qty;

  const record = recordDecision(decision('exit', 'trader', {
    symbol,
    rationale: reason,
    triggerEventId,
    executed: true,
    qty: pos.qty,
    price: exitPrice,
    pnl: pos.unrealizedPnL ?? null,
    orderId,
  }));
  removePositionSnapshot(symbol);

  return JSON.stringify({
    ok: true, symbol, qty: pos.qty, price: exitPrice,
    pnl: pos.unrealizedPnL, reason, decisionId: record.id,
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
  // `triggerEventId`, and journalling here too would count one decision twice. The other
  // two dispositions ARE the decision — a deliberate choice not to act, which is the
  // hardest thing to reconstruct later and the easiest to lose.
  if (disposition !== 'acting') {
    recordDecision(decision('hold', 'trader', {
      symbol,
      triggerEventId: id,
      rationale: note ?? `event ${disposition} with no note`,
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
