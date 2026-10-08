/**
 * Concierge chart tools — publish numeric series for clients to render.
 *
 * The engine publishes the observations, labels and dates without choosing a layout.
 * Each client renders those observations in its own presentation layer. The model receives
 * summary statistics to discuss, not a preformatted chart to reproduce.
 */

import type { ToolDefinition } from '../core/types';
import { collectBars } from '../collect/barSource';
import { isPresent } from '../collect/types';
import { etDate } from '../collect/etDate';
import { ui } from '../ui/ui';
import { comparePerformance } from '../review/benchmark';

const CHART_HINT =
  'This sends chart data to the user interface for rendering. Do not redraw the chart yourself; comment on what the observations show.';

export const CHART_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'show_price_history',
    description: `Draw a price chart for one symbol over a lookback window. ${CHART_HINT}`,
    input_schema: {
      type: 'object',
      properties: {
        symbol:    { type: 'string',  description: 'Ticker symbol, e.g. "AAPL".' },
        days:      { type: 'integer', description: 'Calendar days to look back (default 30).' },
        timeframe: { type: 'string',  description: 'Bar size: "1Day", "1Hour", etc. Default "1Day".' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'show_performance_comparison',
    description: `Show the performance of two things over the same window. Each of "a"/"b" is a ticker symbol, or the literal "ACCOUNT" for the trading account's own equity curve. ${CHART_HINT}`,
    input_schema: {
      type: 'object',
      properties: {
        a:    { type: 'string',  description: 'Ticker symbol or "ACCOUNT".' },
        b:    { type: 'string',  description: 'Ticker symbol or "ACCOUNT".' },
        days: { type: 'integer', description: 'Calendar days to look back (default 30).' },
      },
      required: ['a', 'b'],
    },
  },
];

export async function executeChartTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'show_price_history':          return showPriceHistory(input);
    case 'show_performance_comparison': return showPerformanceComparison(input);
    default:
      return JSON.stringify({ error: `Unknown chart tool: ${name}` });
  }
}

// ── show_price_history ──────────────────────────────────────────────────────────

async function showPriceHistory(input: Record<string, unknown>): Promise<string> {
  const symbol = String(input.symbol ?? '').toUpperCase();
  const days = Number(input.days ?? 30);
  const timeframe = (input.timeframe as string) ?? '1Day';

  if (!symbol) return JSON.stringify({ error: 'symbol is required' });

  const bars = await collectBars(symbol, days + 5, timeframe as any);
  if (!isPresent(bars) || bars.value.length < 2) {
    const msg = `Not enough ${symbol} bars to chart${!isPresent(bars) ? ` — ${bars.error}` : ''}.`;
    ui.replyChart([msg]);
    return JSON.stringify({ error: msg });
  }

  const closes = bars.value.map((b) => b.c);
  const dates = bars.value.map((b) => etDate(Date.parse(b.t)) ?? b.t);

  ui.showChart({ kind: 'price', label: symbol, values: closes, dates });

  const first = closes[0];
  const last = closes[closes.length - 1];
  const high = Math.max(...closes);
  const low = Math.min(...closes);

  return JSON.stringify({
    symbol,
    bars: closes.length,
    from: dates[0],
    to: dates[dates.length - 1],
    firstClose: first,
    lastClose: last,
    high,
    low,
    changePct: first > 0 ? Number((((last / first) - 1) * 100).toFixed(2)) : null,
    stale: bars.stale,
  });
}

// ── show_performance_comparison ─────────────────────────────────────────────────

async function showPerformanceComparison(input: Record<string, unknown>): Promise<string> {
  const a = String(input.a ?? '').toUpperCase(), b = String(input.b ?? '').toUpperCase();
  if (!a || !b) return JSON.stringify({ error: 'both a and b are required' });
  const result = await comparePerformance(a, b, Number(input.days ?? 30));
  if (result.changePctA == null || result.changePctB == null) {
    ui.replyChart(['Performance comparison unavailable: ' + result.caveats.join('; ')]);
  } else {
    ui.showChart({ kind: 'comparison', a: { label: a, values: result.valuesA }, b: { label: b, values: result.valuesB } });
  }
  const { valuesA, valuesB, ...summary } = result;
  return JSON.stringify(summary);
}
