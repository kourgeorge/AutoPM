/**
 * Alpaca market-data tools — direct REST implementation.
 *
 * These replace the MCP subprocess approach. All calls go straight to the
 * Alpaca data and trading APIs via axios, using the same credentials as the broker.
 */

import type { ToolDefinition } from '../core/types';
import {
  alpacaData as dataClient,
  alpacaTrading as tradingClient,
  SIP_EMBARGO_MS,
} from '../core/alpacaHttp';

// ── Tool definitions ──────────────────────────────────────────────────────────

export const ALPACA_DATA_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_stock_bars',
    description: 'Historical OHLCV bars for a stock. Use for momentum, trend, and volatility analysis.',
    input_schema: {
      type: 'object',
      properties: {
        symbols:   { type: 'string',  description: 'Ticker symbol, e.g. "AAPL".' },
        timeframe: { type: 'string',  description: 'Bar size: "1Min", "5Min", "15Min", "1Hour", "1Day". Default "1Day".' },
        limit:     { type: 'integer', description: 'Bars to return, newest last (default 20, max 1000).' },
        start:     { type: 'string',  description: 'ISO 8601 start date, e.g. "2025-01-01". Defaults to a window wide enough for `limit` bars.' },
        end:       { type: 'string',  description: 'ISO 8601 end date. Defaults to 16 minutes ago, the earliest the consolidated tape may be queried.' },
        feed:      { type: 'string',  enum: ['sip', 'iex'], description: 'Leave unset for the full consolidated tape. "iex" is one venue, under 3% of volume — only for comparing against it deliberately.' },
      },
      required: ['symbols'],
    },
  },
  {
    name: 'get_stock_snapshot',
    description: 'Latest quote, latest trade, and minute/daily bars for a symbol in one call.',
    input_schema: {
      type: 'object',
      properties: {
        symbols: { type: 'string', description: 'Ticker symbol, e.g. "NVDA".' },
      },
      required: ['symbols'],
    },
  },
  {
    name: 'get_stock_latest_quote',
    description: 'Current best bid and ask for a symbol.',
    input_schema: {
      type: 'object',
      properties: {
        symbols: { type: 'string', description: 'Ticker symbol.' },
      },
      required: ['symbols'],
    },
  },
  {
    name: 'get_most_active_stocks',
    description: 'Most active stocks by volume or trade count. Use to find trading candidates.',
    input_schema: {
      type: 'object',
      properties: {
        by:  { type: 'string',  enum: ['volume', 'trades'], description: 'Rank by volume or trade count. Default "volume".' },
        top: { type: 'integer', description: 'Number of results (default 10).' },
      },
      required: [],
    },
  },
  {
    name: 'get_market_movers',
    description: 'Top gainers and losers for the session. Use to find momentum candidates.',
    input_schema: {
      type: 'object',
      properties: {
        market_type: { type: 'string', description: 'Market type. Default "stocks".' },
        top:         { type: 'integer', description: 'Number of gainers and losers to return (default 10).' },
      },
      required: [],
    },
  },
  {
    name: 'get_news',
    description: 'Recent news articles for a symbol or market. Prefer this over web_search for financial news.',
    input_schema: {
      type: 'object',
      properties: {
        symbols: { type: 'string',  description: 'Comma-separated tickers, e.g. "AAPL,MSFT". Omit for general market news.' },
        limit:   { type: 'integer', description: 'Articles to return (default 10, max 50).' },
        start:   { type: 'string',  description: 'ISO 8601 start datetime.' },
        end:     { type: 'string',  description: 'ISO 8601 end datetime.' },
      },
      required: [],
    },
  },
  {
    name: 'get_portfolio_history',
    description: 'Account equity and P&L over a historical period.',
    input_schema: {
      type: 'object',
      properties: {
        period:    { type: 'string', description: 'Period: "1D", "1W", "1M", "3M", "1A". Default "1W".' },
        // NOT the bars endpoint's vocabulary, which this used to copy: "1Hour"/"1Day" are
        // rejected here with a 422, and the caller only ever sees the failure.
        timeframe: { type: 'string', description: 'Bar size: "1Min", "5Min", "15Min", "1H", "1D". Periods over 30 days accept "1D" only.' },
      },
      required: [],
    },
  },
];

export const ALPACA_DATA_TOOL_NAMES = new Set(ALPACA_DATA_TOOL_DEFINITIONS.map(t => t.name));

// ── Implementations ───────────────────────────────────────────────────────────

export async function executeAlpacaDataTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'get_stock_bars':          return getStockBars(input);
    case 'get_stock_snapshot':      return getStockSnapshot(input);
    case 'get_stock_latest_quote':  return getStockLatestQuote(input);
    case 'get_most_active_stocks':  return getMostActiveStocks(input);
    case 'get_market_movers':       return getMarketMovers(input);
    case 'get_news':                return getNews(input);
    case 'get_portfolio_history':   return getPortfolioHistory(input);
    default:
      return JSON.stringify({ error: `Unknown alpaca data tool: ${name}` });
  }
}

/**
 * Trading days per bar, for turning a bar count into a default `start`.
 *
 * Only `1Day` needs more than a day of window per bar; the intraday sizes all fit many bars
 * into one session, so one calendar day per bar is generous for them.
 */
const DAYS_PER_BAR: Record<string, number> = {
  '1Min': 1 / 390,
  '5Min': 1 / 78,
  '15Min': 1 / 26,
  '1Hour': 1 / 7,
  '1Day': 1,
};

/**
 * Historical bars for the model to read.
 *
 * Three things this had to stop doing, all of them measured 2026-08-29:
 *
 * `start` now has a default. Alpaca returns `{"bars":{}}` for a `limit` with no `start`, so
 * the tool's own documented default call — a symbol and nothing else — returned no bars at
 * all, silently, for as long as it has existed.
 *
 * `sort: 'desc'` selects the NEWEST bars. Alpaca applies `limit` from the start of the range,
 * so a wide window with an ascending sort hands back the oldest N — the exact opposite of
 * what anyone asking for "the last 20 bars" wants. Each symbol's array is flipped back to
 * ascending before it goes out, because oldest-first is how a series is read.
 *
 * `feed` is no longer pinned to `iex`. IEX is a single venue: AAPL's 2026-08-28 session was
 * 1.08M shares there against 38.85M consolidated, under 3%, and its close was 12 cents off.
 * Unset means the account's own entitlement decides, which is the full tape where there is
 * one. `end` is held 16 minutes back for the same reason `SIP_EMBARGO_MS` exists — a
 * consolidated-tape request reaching into the present is refused outright, not trimmed.
 */
async function getStockBars(input: Record<string, unknown>): Promise<string> {
  const timeframe = String(input.timeframe ?? '1Day');
  const limit = Number(input.limit ?? 20);

  const params: Record<string, unknown> = {
    symbols:   input.symbols,
    timeframe,
    limit,
    sort:      'desc',
    start:     input.start ?? defaultBarStart(limit, timeframe),
    end:       input.end   ?? new Date(Date.now() - SIP_EMBARGO_MS).toISOString(),
  };
  if (input.feed) params.feed = input.feed;

  const res = await dataClient.get<any>('/v2/stocks/bars', { params });

  const bars = res.data?.bars ?? {};
  for (const series of Object.values(bars)) {
    if (Array.isArray(series)) series.reverse();
  }
  return JSON.stringify(res.data);
}

/** A window wide enough that `limit` bars fit inside it, with room for weekends and holidays. */
function defaultBarStart(limit: number, timeframe: string): string {
  const perBar = DAYS_PER_BAR[timeframe] ?? 1;
  const calendarDays = Math.ceil(limit * perBar * (7 / 5) * 2) + 5;
  return new Date(Date.now() - calendarDays * 86_400_000).toISOString();
}

async function getStockSnapshot(input: Record<string, unknown>): Promise<string> {
  const res = await dataClient.get('/v2/stocks/snapshots', {
    params: { symbols: input.symbols, feed: input.feed ?? 'iex' },
  });
  return JSON.stringify(res.data);
}

async function getStockLatestQuote(input: Record<string, unknown>): Promise<string> {
  const res = await dataClient.get('/v2/stocks/quotes/latest', {
    params: { symbols: input.symbols, feed: input.feed ?? 'iex' },
  });
  return JSON.stringify(res.data);
}

async function getMostActiveStocks(input: Record<string, unknown>): Promise<string> {
  const res = await dataClient.get('/v1beta1/screener/stocks/most-actives', {
    params: {
      by:  input.by  ?? 'volume',
      top: input.top ?? 10,
    },
  });
  return JSON.stringify(res.data);
}

async function getMarketMovers(input: Record<string, unknown>): Promise<string> {
  const res = await dataClient.get('/v1beta1/screener/stocks/movers', {
    params: { top: input.top ?? 10 },
  });
  return JSON.stringify(res.data);
}

async function getNews(input: Record<string, unknown>): Promise<string> {
  const params: Record<string, unknown> = { limit: input.limit ?? 10 };
  if (input.symbols) params.symbols = input.symbols;
  if (input.start)   params.start   = input.start;
  if (input.end)     params.end     = input.end;

  const res = await dataClient.get('/v1beta1/news', { params });
  return JSON.stringify(res.data);
}

async function getPortfolioHistory(input: Record<string, unknown>): Promise<string> {
  const params: Record<string, unknown> = { period: input.period ?? '1W' };
  if (input.timeframe) params.timeframe = input.timeframe;

  const res = await tradingClient.get('/v2/account/portfolio/history', { params });
  return JSON.stringify(res.data);
}
