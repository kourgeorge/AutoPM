/**
 * Minimal MCP stdio client for the Alpaca trading server.
 *
 * Spawns `uvx alpaca-mcp-server` over stdio, performs the JSON-RPC handshake,
 * and exposes a `mcpCallTool` function for use by the trader's tool executor.
 *
 * Order-placement tools (place_stock_order, close_position, cancel_all_orders, …)
 * are excluded from the whitelist. All order paths MUST go through
 * `enterPosition` / `exitPosition` so the guard and journal cannot be skipped.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { config } from '../core/config';
import { logger } from '../core/logger';
import type { ToolDefinition } from '../core/types';

// ── JSON-RPC wiring ───────────────────────────────────────────────────────────

let _proc: ChildProcessWithoutNullStreams | null = null;
let _nextId = 1;
const CALL_TIMEOUT_MS = 15_000;

const _pending = new Map<number, {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}>();

function send(method: string, params?: unknown): Promise<unknown> {
  if (!_proc) return Promise.reject(new Error('AlpacaMcp not initialised'));
  return new Promise((resolve, reject) => {
    const id = _nextId++;
    const timer = setTimeout(() => {
      _pending.delete(id);
      reject(new Error(`AlpacaMcp timeout on ${method} (id=${id})`));
    }, CALL_TIMEOUT_MS);
    _pending.set(id, { resolve, reject, timer });
    _proc!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n');
  });
}

function notify(method: string): void {
  _proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export async function initAlpacaMcp(): Promise<void> {
  _proc = spawn('uvx', ['alpaca-mcp-server'], {
    env: {
      ...process.env,
      ALPACA_API_KEY: config.alpaca.keyId,
      ALPACA_SECRET_KEY: config.alpaca.secretKey,
      ALPACA_PAPER_TRADE: 'true',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  _proc.stderr.on('data', (d: Buffer) => {
    const text = d.toString().trim();
    if (text) logger.info(`[AlpacaMcp] ${text}`);
  });
  _proc.on('error', (err) => logger.error(`[AlpacaMcp] spawn error: ${err.message}`));
  _proc.on('exit', (code) => {
    if (code !== 0 && code !== null) logger.error(`[AlpacaMcp] exited with code ${code}`);
    _proc = null;
  });

  const rl = createInterface({ input: _proc.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try { msg = JSON.parse(trimmed); } catch { return; }
    if (msg.id == null) return; // notification, not a response
    const entry = _pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    _pending.delete(msg.id);
    if (msg.error) {
      entry.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
    } else {
      entry.resolve(msg.result);
    }
  });

  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'autotrade', version: '1.0.0' },
  });
  notify('notifications/initialized');
  logger.info('[AlpacaMcp] ready');
}

export function stopAlpacaMcp(): void {
  _proc?.kill();
  _proc = null;
}

// ── Tool call ─────────────────────────────────────────────────────────────────

export async function mcpCallTool(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await send('tools/call', { name, arguments: args }) as any;
  if (result?.content) {
    return (result.content as Array<{ type: string; text?: string }>)
      .filter(c => c.type === 'text')
      .map(c => c.text ?? '')
      .join('');
  }
  return JSON.stringify(result);
}

// ── Whitelisted tool definitions ──────────────────────────────────────────────

export const ALPACA_MCP_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_stock_bars',
    description: 'Historical OHLCV bars for a stock. Use for momentum, trend, and volatility analysis.',
    input_schema: {
      type: 'object',
      properties: {
        symbols: { type: 'string', description: 'Ticker symbol, e.g. "AAPL".' },
        timeframe: { type: 'string', description: 'Bar size: "1Min", "5Min", "15Min", "1Hour", "1Day". Default "1Day".' },
        limit: { type: 'integer', description: 'Bars to return (default 20, max 1000).' },
        start: { type: 'string', description: 'ISO 8601 start date, e.g. "2025-01-01".' },
        end: { type: 'string', description: 'ISO 8601 end date.' },
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
        by: { type: 'string', enum: ['volume', 'trades'], description: 'Rank by volume or trade count. Default "volume".' },
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
        top: { type: 'integer', description: 'Number of gainers and losers to return (default 10).' },
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
        symbols: { type: 'string', description: 'Comma-separated tickers, e.g. "AAPL,MSFT". Omit for general market news.' },
        limit: { type: 'integer', description: 'Articles to return (default 10, max 50).' },
        start: { type: 'string', description: 'ISO 8601 start datetime.' },
        end: { type: 'string', description: 'ISO 8601 end datetime.' },
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
        period: { type: 'string', description: 'Period: "1D", "1W", "1M", "3M", "1A". Default "1W".' },
        timeframe: { type: 'string', description: 'Bar size: "1Min", "5Min", "15Min", "1Hour", "1Day".' },
      },
      required: [],
    },
  },
];

export const ALPACA_MCP_TOOL_NAMES = new Set(ALPACA_MCP_TOOL_DEFINITIONS.map(t => t.name));
