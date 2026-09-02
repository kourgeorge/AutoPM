/**
 * Logger — writes through the blessed terminal UI when available,
 * falls back to console when running non-interactively (piped, CI, etc.).
 */

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'TRADE' | 'TOOL';

let _ui: { log: (level: LogLevel, msg: string) => void } | null = null;

export function attachUI(ui: typeof _ui): void {
  _ui = ui;
}

function write(level: LogLevel, msg: string, data?: unknown): void {
  const full = data !== undefined ? `${msg} ${JSON.stringify(data)}` : msg;
  if (_ui) {
    _ui.log(level, full);
  } else {
    const ts = new Date().toISOString();
    const out = `[${ts}] ${level.padEnd(5)} ${full}`;
    level === 'ERROR' ? console.error(out) : console.log(out);
  }
}

/**
 * Log a tool call result. agent = e.g. 'Orchestrator', 'Monitor:AAPL', 'Research:TSLA'
 *
 * Rendered as a call signature — `toolName(args) → result` — so both sides of the call are
 * always visible, not just on failure: on the happy path the args are what makes it possible
 * to tell two calls to the same tool apart at a glance.
 */
function logTool(agent: string, toolName: string, result: string, input?: unknown): void {
  const summary = summarizeResult(toolName, result);
  const args = input !== undefined ? formatArgs(input) : '';
  write('TOOL', `[${agent}] ${toolName}(${args}) → ${summary}`);
}

// Generous now that the UI wraps long TOOL lines with a hanging indent instead of clipping at
// the box edge — there's room to actually show the payload instead of a stub of it.
const MAX_LEN = 400;

function truncate(s: string, max: number = MAX_LEN): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function formatArgs(input: unknown): string {
  if (input == null || typeof input !== 'object') return input === undefined ? '' : String(input);
  const parts = Object.entries(input as Record<string, unknown>).map(([k, v]) => `${k}=${formatValue(v)}`);
  return truncate(parts.join(', '));
}

/** Top-level entry point for a whole JSON payload — unlike the recursive `formatValue` this
 *  caps the result, since a bars array or fundamentals blob has no inherent size limit. */
function formatResult(v: unknown): string {
  return truncate(formatValue(v));
}

/** `key=value` pairs read closer to a function signature than a JSON blob's quotes and braces. */
function formatValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return `"${v}"`;
  if (Array.isArray(v)) return `[${v.map(formatValue).join(', ')}]`;
  if (typeof v === 'object') {
    const parts = Object.entries(v as Record<string, unknown>).map(([k, val]) => `${k}=${formatValue(val)}`);
    return `{${parts.join(', ')}}`;
  }
  return String(v);
}

function summarizeResult(tool: string, raw: string): string {
  try {
    const r = JSON.parse(raw);
    if (r.error) return `ERROR: ${r.error}`;

    switch (tool) {
      case 'get_market_status':
        return `market ${r.isOpen ? 'OPEN' : 'CLOSED'}, ET ${r.etTime}${r.minutesUntilChange != null ? `, ${r.minutesUntilChange}min to ${r.changeLabel}` : ''}`;
      case 'get_account':
        return `equity $${r.equity?.toFixed(2)}, cash $${r.cash?.toFixed(2)}, dailyPnL ${r.dailyPnL >= 0 ? '+' : ''}$${r.dailyPnL?.toFixed(2)} (${r.dailyPnLPct?.toFixed(2)}%)${r.lossLimitBreached ? ' ⚠ LOSS LIMIT' : ''}`;
      case 'get_positions':
        return r.count === 0
          ? 'no open positions'
          : r.positions.map((p: any) => `${p.symbol} ${p.qty}sh $${p.marketValue?.toFixed(0)} P&L ${p.unrealizedPnL >= 0 ? '+' : ''}$${p.unrealizedPnL?.toFixed(0)}`).join(' | ');
      case 'get_bars':
        return Array.isArray(r) ? `${r.length} bars, last close $${r.at(-1)?.c?.toFixed(2)}` : formatResult(r);
      case 'get_indicators':
        return `RSI ${r.rsi?.toFixed(1)}, EMA9 $${r.ema9?.toFixed(2)}, EMA21 $${r.ema21?.toFixed(2)}, ATR ${r.atr?.toFixed(2)}`;
      case 'get_calendar':
        return r.nextEarningsAt
          ? `earnings ${r.nextEarningsAt.slice(0, 10)} (${r.daysUntil}d${r.isEstimate === true ? ', est' : ''})`
          : `${r.symbol}: no earnings date reported${r.caveats?.length ? ` — ${r.caveats.length} caveat(s)` : ''}`;
      case 'get_fundamentals':
        return `${r.symbol}: mcap ${r.liquidity?.marketCap != null ? `$${(r.liquidity.marketCap / 1e9).toFixed(1)}B` : 'n/a'}, ` +
          `short ${r.crowding?.shortPctOfFloat ?? 'n/a'}%, margin ${r.balanceSheet?.profitMarginsPct ?? 'n/a'}%, ` +
          `revisions +${r.revisions?.currentQuarter?.upLast30days ?? 'n/a'}/-${r.revisions?.currentQuarter?.downLast30days ?? 'n/a'} (30d)`;
      case 'get_macro_indicators':
        return `SPY ${r.spy?.change1dPct > 0 ? '+' : ''}${r.spy?.change1dPct?.toFixed(2)}%, VIX ${r.vix?.level?.toFixed(1)}`;
      case 'execute_entry':
        return r.ok ? `entered ${r.symbol} ${r.qty}sh @ $${r.price}` : `BLOCKED: ${r.error}`;
      case 'execute_exit':
        return r.ok ? `exited ${r.symbol}` : `FAILED: ${r.error}`;
      case 'run_monitor_agent':
        return `${r.symbol}: ${r.action?.toUpperCase()} — ${r.reason}`;
      case 'run_research_agent':
        return `${r.symbol}: ${r.action?.toUpperCase()} — ${r.reason}`;
      case 'run_idea_agent':
        return Array.isArray(r.ideas) ? `${r.ideas.length} idea(s): ${r.ideas.map((i: any) => i.symbol).join(', ')}` : 'no ideas';
      case 'web_search':
        return Array.isArray(r) ? `${r.length} results` : formatResult(r);
      case 'search_news':
        return Array.isArray(r) ? `${r.length} articles` : formatResult(r);
      case 'get_sec_filing_summary':
        return typeof r.summary === 'string' ? truncate(r.summary) : formatResult(r);
      case 'reply':
        return 'sent';
      case 'sleep':
        return `next cycle in ${r.nextCycleIn}`;
      default:
        return formatResult(r);
    }
  } catch {
    return truncate(raw);
  }
}

export const logger = {
  info:  (msg: string, data?: unknown) => write('INFO',  msg, data),
  warn:  (msg: string, data?: unknown) => write('WARN',  msg, data),
  error: (msg: string, data?: unknown) => write('ERROR', msg, data),
  trade: (msg: string, data?: unknown) => write('TRADE', msg, data),
  tool:  logTool,
};
