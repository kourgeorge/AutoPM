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

/** Log a tool call result. agent = e.g. 'Orchestrator', 'Monitor:AAPL', 'Research:TSLA' */
function logTool(agent: string, toolName: string, result: string): void {
  const summary = summarizeResult(toolName, result);
  write('TOOL', `[${agent}] ${toolName} → ${summary}`);
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
        return Array.isArray(r) ? `${r.length} bars, last close $${r.at(-1)?.c?.toFixed(2)}` : raw.slice(0, 80);
      case 'get_indicators':
        return `RSI ${r.rsi?.toFixed(1)}, EMA9 $${r.ema9?.toFixed(2)}, EMA21 $${r.ema21?.toFixed(2)}, ATR ${r.atr?.toFixed(2)}`;
      case 'get_earnings_calendar':
        return Array.isArray(r) && r.length > 0
          ? r.slice(0, 3).map((e: any) => `${e.symbol} ${e.date}`).join(', ')
          : 'no upcoming earnings';
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
        return Array.isArray(r) ? `${r.length} results` : raw.slice(0, 80);
      case 'search_news':
        return Array.isArray(r) ? `${r.length} articles` : raw.slice(0, 80);
      case 'get_sec_filing_summary':
        return typeof r.summary === 'string' ? r.summary.slice(0, 100) : raw.slice(0, 80);
      case 'reply':
        return 'sent';
      case 'sleep':
        return `next cycle in ${r.nextCycleIn}`;
      default:
        return raw.length > 120 ? raw.slice(0, 120) + '…' : raw;
    }
  } catch {
    return raw.length > 120 ? raw.slice(0, 120) + '…' : raw;
  }
}

export const logger = {
  info:  (msg: string, data?: unknown) => write('INFO',  msg, data),
  warn:  (msg: string, data?: unknown) => write('WARN',  msg, data),
  error: (msg: string, data?: unknown) => write('ERROR', msg, data),
  trade: (msg: string, data?: unknown) => write('TRADE', msg, data),
  tool:  logTool,
};
