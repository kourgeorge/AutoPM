/**
 * Learning on vs off, side by side, without grading learned weights on the years that chose them.
 *
 * The learning layer picks weights and admits learned signals on the same 2016-to-today history
 * the baseline backtest replays. So the "on" run is in-sample up to the day the current set was
 * last changed: only the days after that are a fair test. `tunedThrough` finds that day from the
 * learning history (`learning-runs`, each learned signal's `activeSince`); the report shows the
 * full range marked in-sample and the after-that part as the out-of-sample figure, for both runs.
 */
import { readRecords, readValue } from '../core/storage';
import { LEARNING_OFF, type SignalSetup } from '../signals/registry';
import { scorecard } from './metrics';
import type { BacktestResult } from './engine';

interface RunRow { at: string; tradingDay?: string; weightsBefore?: Record<string, number>; weightsAfter?: Record<string, number>; active?: { id: string }[] }
interface CandidateRow { id: string; activeSince?: string; liveSince?: string }

const dayOf = (s: string | undefined): string | null => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const sameWeights = (a: Record<string, number> = {}, b: Record<string, number> = {}): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 1) !== (b[k] ?? 1)) return false;
  return true;
};

/** True when the setup is the same as learning off: every weight 1 and no learned signals. */
export function isLearningOff(setup: SignalSetup): boolean {
  return setup.learned.length === 0 && sameWeights(setup.weights, LEARNING_OFF.weights);
}

/**
 * The last day the given set was shaped by learning, so days after it are out-of-sample.
 * `null` = nothing learned (learning off). `'unknown'` = learned but no dated history found,
 * so the whole range must be treated as in-sample.
 */
export function tunedThrough(setup: SignalSetup): string | null | 'unknown' {
  if (isLearningOff(setup)) return null;
  const dates: string[] = [];
  let runs: RunRow[] = [];
  try { runs = readRecords<RunRow>('learning-runs'); } catch { runs = []; }
  let prevActive = '';
  for (const r of runs) {
    const active = (r.active ?? []).map(a => a.id).sort().join(',');
    const changed = !sameWeights(r.weightsBefore, r.weightsAfter) || active !== prevActive;
    prevActive = active;
    const d = dayOf(r.tradingDay) ?? dayOf(r.at);
    if (changed && d) dates.push(d);
  }
  if (setup.learned.length > 0) {
    let cands: CandidateRow[] = [];
    try { cands = readRecords<CandidateRow>('learning-signals'); } catch { cands = []; }
    for (const l of setup.learned) {
      const c = cands.find(x => x.id === l.id);
      const d = dayOf(c?.activeSince) ?? dayOf(c?.liveSince);
      if (d) dates.push(d);
    }
  }
  if (dates.length === 0) {
    let at: string | undefined;
    try { at = readValue<{ at?: string }>('learningLive')?.at; } catch { at = undefined; }
    const d = dayOf(at);
    if (d) dates.push(d);
  }
  return dates.length === 0 ? 'unknown' : dates.sort()[dates.length - 1];
}

export interface WindowStats { from: string; trades: number; winRate: number | null; expectancyPct: number | null; grossPnL: number; returnPct: number | null }

/** Results for trades entered after `since`, and the equity return from the close of `since` to the end. */
export function statsAfter(result: BacktestResult, since: string, initialEquity: number): WindowStats {
  const sc = scorecard(result.trades.filter(t => t.entryAt > since));
  const before = result.equityCurve.filter(p => p.date <= since);
  const startEquity = before.length > 0 ? before[before.length - 1].equity : initialEquity;
  const after = result.equityCurve.filter(p => p.date > since);
  const returnPct = after.length > 0 && startEquity > 0
    ? parseFloat((((after[after.length - 1].equity - startEquity) / startEquity) * 100).toFixed(2)) : null;
  return { from: since, trades: sc.trades, winRate: sc.winRate, expectancyPct: sc.expectancyPct, grossPnL: sc.grossPnL, returnPct };
}

const pct = (n: number | null) => (n == null ? '—' : `${n.toFixed(2)}%`);
const money = (n: number) => `$${n.toFixed(2)}`;

function weightsLine(setup: SignalSetup): string {
  const entries = Object.entries(setup.weights).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? 'every signal 1' : entries.map(([k, v]) => `${k} ${v}`).join(', ') + ' (any other signal 1)';
}

/** The "learning on vs off" Markdown section. `on` is absent when the live set equals learning off. */
export function renderLearningComparison(input: {
  start: string; end: string; initialEquity: number;
  off: BacktestResult; on: BacktestResult | null; onSetup: SignalSetup; tunedThrough: string | null | 'unknown';
}): string {
  const { start, end, initialEquity, off, on, onSetup } = input;
  const lines: string[] = ['## Learning on vs off', ''];
  lines.push(`- Off: weights ${weightsLine(LEARNING_OFF)}; learned signals: none.`);
  lines.push(`- On: weights ${weightsLine(onSetup)}; learned signals: ${onSetup.learned.length === 0 ? 'none' : onSetup.learned.map(l => l.name).join(', ')}.`);
  lines.push('');
  const full = (r: BacktestResult) => {
    const sc = scorecard(r.trades);
    return { trades: sc.trades, winRate: sc.winRate, expectancyPct: sc.expectancyPct, grossPnL: sc.grossPnL,
      returnPct: parseFloat((((r.finalEquity - initialEquity) / initialEquity) * 100).toFixed(2)) };
  };
  const row = (label: string, s: { trades: number; winRate: number | null; expectancyPct: number | null; grossPnL: number; returnPct: number | null }) =>
    `| ${label} | ${s.trades} | ${pct(s.winRate)} | ${pct(s.expectancyPct)} | ${money(s.grossPnL)} | ${pct(s.returnPct)} |`;
  lines.push('| Run | Trades | Win rate | Expectancy | Gross P&L | Return |');
  lines.push('|---|---|---|---|---|---|');
  if (!on) {
    lines.push(row(`Off, ${start} to ${end}`, full(off)));
    lines.push('');
    lines.push('The live set is the same as learning off (every weight 1, no learned signals), so only one run was made.');
    return lines.join('\n') + '\n';
  }
  const tt = input.tunedThrough;
  const inSample = tt === 'unknown' ? 'all in-sample: no dated learning history found' : `in-sample through ${tt}`;
  lines.push(row(`Off, ${start} to ${end}`, full(off)));
  lines.push(row(`On, ${start} to ${end} (${inSample})`, full(on)));
  if (tt && tt !== 'unknown' && tt < end) {
    lines.push(row(`Off, after ${tt}`, statsAfter(off, tt, initialEquity)));
    lines.push(row(`On, after ${tt} (out-of-sample)`, statsAfter(on, tt, initialEquity)));
  }
  lines.push('');
  lines.push(tt === 'unknown' || !tt || tt >= end
    ? 'The learned set was chosen on this same history, so the "on" figures are in-sample and are not evidence that learning helps.'
    : `The learned set was chosen on history through ${tt}. Only the "after ${tt}" rows are a fair comparison; `
      + 'the full-range "on" row is in-sample and is not evidence that learning helps.');
  return lines.join('\n') + '\n';
}
