/**
 * ASCII chart rendering for the concierge's chart tools.
 *
 * Pure formatting, same discipline as `format.ts` — no blessed import. Callers own the box,
 * the framing, and the clipping; this file only turns numbers into rows of text.
 *
 * Monochrome on purpose: `asciichart` colors a series by wrapping it in raw ANSI escapes,
 * which blessed's `{tag}`-based color model does not parse — an ANSI code would render as
 * literal garbage characters in the log box. Passing no `colors` config means `asciichart`
 * never emits one (see `colored()` in its source), so this is not a stripping step, it's just
 * an option left unset.
 */

import * as asciichart from 'asciichart';

const CHART_HEIGHT = 12;

/**
 * Columns asciichart spends on its y-axis labels, reserved before the plot area.
 *
 * Not the `offset` config (default 3) alone: asciichart's row array pre-fills every cell with
 * a single space, then for each labeled row overwrites ONE cell with the whole formatted label
 * string — so that row's real length is `seriesLength + offset - 1 + label.length`, not
 * `seriesLength + offset`. The label is always padded to its default `padding` string's length
 * (11 chars) by `(padding + x.toFixed(2)).slice(-padding.length)`, regardless of the number's own
 * magnitude, as long as the formatted number is under 11 characters — true for any price or
 * account-equity figure this app charts. So the reserve is a fixed `offset - 1 + 11 = 13`.
 */
const AXIS_RESERVE = 13;

/**
 * Thin a series to at most `maxPoints` columns, always keeping the last point exact.
 *
 * asciichart spends one column per array element — a 90-day series would overrun any
 * reasonable terminal width untouched, so this picks evenly spaced samples rather than
 * truncating the tail off the window.
 */
function downsample(values: number[], maxPoints: number): number[] {
  if (maxPoints <= 0 || values.length <= maxPoints) return values;
  const step = values.length / maxPoints;
  const out: number[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(values[Math.floor(i * step)]);
  out[out.length - 1] = values[values.length - 1];
  return out;
}

function plotWidth(width: number): number {
  return Math.max(10, width - AXIS_RESERVE);
}

/** A single-series chart: title, plot, and a first-date → last-date footer. */
export function renderPriceChart(
  label: string,
  values: number[],
  dates: string[],
  width: number,
): string[] {
  if (values.length < 2) return [`${label}: not enough data to chart`];

  const plotted = downsample(values, plotWidth(width));
  const chart = asciichart.plot(plotted, { height: CHART_HEIGHT });
  const from = dates[0] ?? '';
  const to = dates[dates.length - 1] ?? '';

  return [label, ...chart.split('\n'), from && to ? `${from}  →  ${to}` : from || to];
}

/**
 * Two stacked single-series charts on one shared scale, not one overlaid multi-series chart.
 *
 * Each series is normalized to % change from its own first value, so a $400 stock and a
 * $40,000 account balance plot on the same footing. The shared `{min, max}` (the combined
 * range of both, passed explicitly to both `plot` calls) is what makes the two panels
 * comparable at a glance — without color, an overlay of two series is not legible in a
 * terminal, but two panels with the same vertical scale are.
 */
export function renderComparisonChart(
  a: { label: string; values: number[] },
  b: { label: string; values: number[] },
  width: number,
): string[] {
  if (a.values.length < 2 || b.values.length < 2) {
    return ['Not enough overlapping data to compare.'];
  }

  const normalize = (values: number[]): number[] => {
    const base = values[0];
    return base > 0 ? values.map((v) => (v / base - 1) * 100) : values.map(() => 0);
  };
  const na = normalize(a.values);
  const nb = normalize(b.values);

  const min = Math.min(...na, ...nb);
  const max = Math.max(...na, ...nb);
  const maxPoints = plotWidth(width);
  const chartA = asciichart.plot(downsample(na, maxPoints), { height: CHART_HEIGHT, min, max });
  const chartB = asciichart.plot(downsample(nb, maxPoints), { height: CHART_HEIGHT, min, max });

  const changeA = na[na.length - 1];
  const changeB = nb[nb.length - 1];
  const sign = (n: number): string => (n >= 0 ? '+' : '');
  const summary = `${a.label}: ${sign(changeA)}${changeA.toFixed(1)}%   ${b.label}: ${sign(changeB)}${changeB.toFixed(1)}%   (${sign(changeA - changeB)}${(changeA - changeB).toFixed(1)}pp)`;

  return [
    `${a.label} (% change)`,
    ...chartA.split('\n'),
    '',
    `${b.label} (% change)`,
    ...chartB.split('\n'),
    '',
    summary,
  ];
}
