/**
 * Concierge chart tools — draw directly into the terminal instead of describing numbers.
 *
 * Same reason `pushAlert` in `concierge.ts` writes to `ui.alert()` directly rather than
 * routing through the model: a model asked to reproduce a whitespace-exact multi-line ASCII
 * chart in its own generated text will paraphrase or re-indent it. So the executor renders
 * the chart and calls `ui.replyChart()` itself; what goes back to the model as the tool
 * result is numeric summary stats for it to comment on in its own words, never the chart text.
 */

import type { ToolDefinition } from '../core/types';
import { config } from '../core/config';
import { alpacaTrading } from '../core/alpacaHttp';
import { collectBars } from '../collect/barSource';
import { isPresent } from '../collect/types';
import { etDate } from '../collect/etDate';
import { renderComparisonChart, renderPriceChart } from '../ui/chart';
import { ui } from '../ui/ui';

const CHART_HINT =
  'This draws the chart directly in the terminal — do not try to describe or redraw it yourself, just comment on what it shows.';

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
    description: `Draw two stacked charts comparing % change of two things over the same window, plus a one-line summary. Each of "a"/"b" is a ticker symbol, or the literal "ACCOUNT" for the trading account's own equity curve. ${CHART_HINT}`,
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

  ui.replyChart(renderPriceChart(symbol, closes, dates, ui.chartWidth()));

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

/** ET date → level, for one leg of a comparison. */
interface Leg {
  series: Map<string, number>;
  error: string | null;
}

async function fetchAccountLeg(days: number): Promise<Leg> {
  if (config.broker !== 'alpaca') {
    return { series: new Map(), error: `account equity unavailable — BROKER is '${config.broker}'` };
  }
  try {
    const res = await alpacaTrading.get('/v2/account/portfolio/history', {
      params: { period: `${days}D`, timeframe: '1D' },
    });
    const stamps: unknown[] = Array.isArray(res.data?.timestamp) ? res.data.timestamp : [];
    const equity: unknown[] = Array.isArray(res.data?.equity) ? res.data.equity : [];

    const series = new Map<string, number>();
    for (let i = 0; i < Math.min(stamps.length, equity.length); i++) {
      const value = Number(equity[i]);
      if (!Number.isFinite(value) || value <= 0) continue;
      const date = etDate(Number(stamps[i]) * 1000);
      if (date) series.set(date, value);
    }
    return { series, error: series.size === 0 ? 'account equity returned no usable points' : null };
  } catch (err: any) {
    return { series: new Map(), error: `account equity unavailable — ${err?.message ?? err}` };
  }
}

async function fetchSymbolLeg(symbol: string, days: number): Promise<Leg> {
  const bars = await collectBars(symbol, days + 10, '1Day');
  if (!isPresent(bars)) {
    return { series: new Map(), error: `${symbol} bars unavailable — ${bars.error}` };
  }
  const series = new Map<string, number>();
  for (const bar of bars.value) {
    const date = etDate(Date.parse(bar.t));
    if (date && Number.isFinite(bar.c) && bar.c > 0) series.set(date, bar.c);
  }
  return { series, error: series.size === 0 ? `${symbol} bars carried no usable closes` : null };
}

function fetchLeg(name: string, days: number): Promise<Leg> {
  return name.toUpperCase() === 'ACCOUNT' ? fetchAccountLeg(days) : fetchSymbolLeg(name.toUpperCase(), days);
}

async function showPerformanceComparison(input: Record<string, unknown>): Promise<string> {
  const aName = String(input.a ?? '');
  const bName = String(input.b ?? '');
  const days = Number(input.days ?? 30);

  if (!aName || !bName) return JSON.stringify({ error: 'both a and b are required' });

  const [legA, legB] = await Promise.all([fetchLeg(aName, days), fetchLeg(bName, days)]);
  if (legA.error || legB.error) {
    const msg = [legA.error, legB.error].filter(Boolean).join('; ');
    ui.replyChart([`Could not build the comparison: ${msg}`]);
    return JSON.stringify({ error: msg });
  }

  // Aligned by ET date, never by index, for the same reason `benchmark.ts` does this: around a
  // holiday the two series differ in length, and an index join would compare a Tuesday to a
  // Wednesday for the rest of the window.
  const dates = [...legA.series.keys()].filter((d) => legB.series.has(d)).sort();
  if (dates.length < 2) {
    const msg = `${aName.toUpperCase()} and ${bName.toUpperCase()} share fewer than 2 common trading dates in this window.`;
    ui.replyChart([msg]);
    return JSON.stringify({ error: msg });
  }

  const valuesA = dates.map((d) => legA.series.get(d)!);
  const valuesB = dates.map((d) => legB.series.get(d)!);

  ui.replyChart(
    renderComparisonChart(
      { label: aName.toUpperCase(), values: valuesA },
      { label: bName.toUpperCase(), values: valuesB },
      ui.chartWidth(),
    ),
  );

  const changePct = (values: number[]) => Number((((values[values.length - 1] / values[0]) - 1) * 100).toFixed(2));
  const changeA = changePct(valuesA);
  const changeB = changePct(valuesB);

  return JSON.stringify({
    a: aName.toUpperCase(),
    b: bName.toUpperCase(),
    from: dates[0],
    to: dates[dates.length - 1],
    sessions: dates.length,
    changePctA: changeA,
    changePctB: changeB,
    excessPct: Number((changeA - changeB).toFixed(2)),
  });
}
