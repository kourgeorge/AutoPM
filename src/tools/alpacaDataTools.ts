/**
 * Alpaca market-data tools — direct REST implementation.
 *
 * These replace the MCP subprocess approach. All calls go straight to the
 * Alpaca data and trading APIs via axios, using the same credentials as the broker.
 */

import axios, { AxiosInstance } from 'axios';
import { config } from '../core/config';
import type { ToolDefinition } from '../core/types';

function makeDataClient(): AxiosInstance {
  return axios.create({
    baseURL: config.alpaca.dataUrl,
    headers: {
      'APCA-API-KEY-ID': config.alpaca.keyId,
      'APCA-API-SECRET-KEY': config.alpaca.secretKey,
    },
  });
}

function makeTradingClient(): AxiosInstance {
  return axios.create({
    baseURL: config.alpaca.baseUrl,
    headers: {
      'APCA-API-KEY-ID': config.alpaca.keyId,
      'APCA-API-SECRET-KEY': config.alpaca.secretKey,
    },
  });
}

const dataClient     = makeDataClient();
const tradingClient  = makeTradingClient();

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
        limit:     { type: 'integer', description: 'Bars to return (default 20, max 1000).' },
        start:     { type: 'string',  description: 'ISO 8601 start date, e.g. "2025-01-01".' },
        end:       { type: 'string',  description: 'ISO 8601 end date.' },
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
        timeframe: { type: 'string', description: 'Bar size: "1Min", "5Min", "15Min", "1Hour", "1Day".' },
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

async function getStockBars(input: Record<string, unknown>): Promise<string> {
  const params: Record<string, unknown> = {
    symbols:   input.symbols,
    timeframe: input.timeframe ?? '1Day',
    limit:     input.limit ?? 20,
    feed:      input.feed ?? 'iex',
  };
  if (input.start) params.start = input.start;
  if (input.end)   params.end   = input.end;

  const res = await dataClient.get('/v2/stocks/bars', { params });
  return JSON.stringify(res.data);
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
