/**
 * Measures whether a signal predicts anything.
 *
 * The question asked of every signal: on a given day, did the stocks it scored higher go on
 * to do better than the ones it scored lower? For each day we rank all stocks by the signal's
 * score and by what they returned from the next day's open to the close five trading days
 * later, and take the rank correlation of the two lists — the "IC". +1 means the order was
 * perfectly right, 0 means no better than chance, negative means it was backwards.
 *
 * The bars are only ever the ones up to the scored day, and the return starts at the NEXT
 * day's open, so nothing a trade could not have known leaks in.
 *
 * Periods:
 *   learn   everything older than the last two years — used to come up with and tune ideas
 *   exam    the last two years — not looked at while tuning
 *   live    days after the signal was created — the only truly unseen period
 * learn/exam use every fifth day so no two days share the same five-day return; live uses
 * every day and corrects its t-figure for the overlap.
 *
 * Code measures, nothing here decides — that is `loop.ts`.
 */
import type { Bar } from '../core/types';
import type { Policy } from '../policy/types';
import { Signal, SignalContext } from '../signals/signal';
import { BUILT_IN_SIGNALS } from '../signals/registry';
import { SandboxedSignal } from '../signals/sandboxed';
import { WINDOW, windowAt } from './sandbox';

export const HORIZON = 5;
const EXAM_YEARS = 2;
const DAILY_DAYS = 260;      // the last year is scored every day, for the live period
export const MIN_STOCKS = 10;

export type Period = 'learn' | 'exam' | 'live' | 'lastYear';
export interface PeriodStats {
  days: number;            // scored days
  meanIC: number | null;   // average rank agreement, -1..+1
  tStat: number | null;    // how sure: |t| above ~2 is unlikely to be luck for ONE idea tested
  hitRate: number | null;  // share of days the order was more right than wrong
  spreadPct: number | null; // avg 5-day return of the top third minus the bottom third, in %
  upMarketIC: number | null;   // meanIC on days SPY was above its 200-day average
  downMarketIC: number | null; // ... and below it
}
/** `etfOnly`: the same periods measured on the ETFs alone (see `LEARNING_ETFS`), when they were scored. */
export interface SignalReport { name: string; periods: Record<Period, PeriodStats>; etfOnly?: Record<Period, PeriodStats> }

interface DayPoint { date: string; daily: boolean; up: boolean | null; scores: (number | null)[]; fwd: number[] }

export interface Universe {
  dates: string[];                          // calendar (SPY's trading days)
  examStart: string;
  symbols: string[];
  bars: Map<string, Bar[]>;
  index: Map<string, Map<string, number>>;  // symbol -> date -> bar index
  sampleDates: { date: string; daily: boolean; up: boolean | null }[];
}

const day = (b: Bar) => b.t.slice(0, 10);

export function buildUniverse(bars: Map<string, Bar[]>): Universe {
  const spy = bars.get('SPY') ?? [...bars.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  const dates = spy.map(day);
  const index = new Map<string, Map<string, number>>();
  for (const [s, series] of bars) index.set(s, new Map(series.map((b, i) => [day(b), i])));
  const last = dates[dates.length - 1] ?? '';
  const examStart = last ? `${Number(last.slice(0, 4)) - EXAM_YEARS}${last.slice(4)}` : '';
  // Up/down market: SPY against its 200-day average on that day.
  const closes = spy.map(b => b.c);
  const up = (i: number) => i < 200 ? null : closes[i] > closes.slice(i - 199, i + 1).reduce((a, c) => a + c, 0) / 200;
  const sampleDates: Universe['sampleDates'] = [];
  for (let i = WINDOW; i < dates.length - HORIZON - 1; i++) {
    const daily = i >= dates.length - DAILY_DAYS - HORIZON - 1;
    if ((dates.length - 1 - i) % HORIZON === 0 || daily) sampleDates.push({ date: dates[i], daily, up: up(i) });
  }
  return { dates, examStart, symbols: [...bars.keys()], bars, index, sampleDates };
}

/** Next open → close HORIZON days later, as a fraction; null when the bars are not there. */
function forward(bars: Bar[], i: number): number | null {
  const entry = bars[i + 1]?.o, exit = bars[i + HORIZON]?.c;
  return entry > 0 && exit > 0 ? exit / entry - 1 : null;
}

/** score(symbol, barIndex) for every symbol × sample date. Returns per-signal-name grids. */
export interface Scored { names: string[]; points: DayPoint[] }

function grid(u: Universe, names: string[], scoreSymbol: (symbol: string, bars: Bar[], idx: number[]) => (number | null)[][]): Scored {
  // points[d].scores[s*names + k]
  const perSymbol = new Map<string, Map<string, (number | null)[]>>();
  for (const s of u.symbols) {
    const bars = u.bars.get(s)!, idxMap = u.index.get(s)!;
    const wanted: number[] = [], wantedDates: string[] = [];
    for (const d of u.sampleDates) {
      const i = idxMap.get(d.date);
      if (i === undefined || i < WINDOW - 1 || forward(bars, i) === null) continue;
      wanted.push(i); wantedDates.push(d.date);
    }
    const rows = wanted.length ? scoreSymbol(s, bars, wanted) : [];
    perSymbol.set(s, new Map(wantedDates.map((d, k) => [d, rows[k]])));
  }
  const points: DayPoint[] = [];
  for (const d of u.sampleDates) {
    const scores: (number | null)[] = [], fwd: number[] = [];
    for (const s of u.symbols) {
      const row = perSymbol.get(s)!.get(d.date);
      if (!row) continue;
      const bars = u.bars.get(s)!;
      fwd.push(forward(bars, u.index.get(s)!.get(d.date)!)!);
      scores.push(...row);
    }
    points.push({ date: d.date, daily: d.daily, up: d.up, scores, fwd });
  }
  return { names, points };
}

/**
 * Any list of signals, one column each. Built-ins run in-process on a shared context per
 * stock-day; model-written ones go to the sandbox in one batch per stock.
 * A "no reading" is null and is left out of that day's ranking, never counted as 0.
 */
export function scoreSignals(u: Universe, signals: readonly Signal[], policy: Policy): Scored {
  return grid(u, signals.map(s => s.name), (_s, bars, idx) => {
    const cols = signals.map(sig => sig instanceof SandboxedSignal
      ? sig.runMany(idx.map(i => windowAt(bars, i)))
      : idx.map(i => {
          const r = sig.evaluate(ctxAt(bars, i, policy));
          return r ? r.score : null;
        }));
    return idx.map((_, k) => cols.map(c => c[k]));
  });
}

/** Contexts for one stock-day, shared by every built-in scored on it. */
const ctxMemo = new WeakMap<Bar[], Map<number, SignalContext>>();
function ctxAt(bars: Bar[], i: number, policy: Policy): SignalContext {
  let m = ctxMemo.get(bars);
  if (!m) { m = new Map(); ctxMemo.set(bars, m); }
  let c = m.get(i);
  if (!c) {
    c = new SignalContext(bars.slice(i - WINDOW + 1, i + 1), policy);
    if (m.size > 2_000) m.clear();
    m.set(i, c);
  }
  return c;
}

/** The hand-written signals of every family. */
export function scoreBuiltIns(u: Universe, policy: Policy): Scored {
  return scoreSignals(u, BUILT_IN_SIGNALS, policy);
}

function ranks(xs: number[]): number[] {
  const order = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < order.length;) {
    let j = i; while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}
function pearson(a: number[], b: number[]): number | null {
  const n = a.length; if (n < 3) return null;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

/** Rank agreement (Spearman, -1..+1) between two equal-length lists; null below three pairs or with no spread. */
export function rankCorrelation(a: number[], b: number[]): number | null { return pearson(ranks(a), ranks(b)); }

interface DayResult { date: string; daily: boolean; up: boolean | null; ic: number; spread: number }

function dayResults(sc: Scored, k: number): DayResult[] {
  const width = sc.names.length, out: DayResult[] = [];
  for (const p of sc.points) {
    const xs: number[] = [], ys: number[] = [];
    for (let s = 0; s < p.fwd.length; s++) { const v = p.scores[s * width + k]; if (v !== null) { xs.push(v); ys.push(p.fwd[s]); } }
    if (xs.length < MIN_STOCKS || new Set(xs).size < 3) continue;
    const ic = pearson(ranks(xs), ranks(ys));
    if (ic === null) continue;
    const order = xs.map((v, i) => [v, ys[i]] as const).sort((a, b) => a[0] - b[0]), third = Math.floor(order.length / 3);
    const avg = (r: (readonly [number, number])[]) => r.reduce((a, x) => a + x[1], 0) / r.length;
    out.push({ date: p.date, daily: p.daily, up: p.up, ic, spread: third ? avg(order.slice(-third)) - avg(order.slice(0, third)) : 0 });
  }
  return out;
}

const r3 = (x: number | null) => x === null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000;
function stats(rows: DayResult[], overlap = 1): PeriodStats {
  const n = rows.length;
  const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const ics = rows.map(r => r.ic), m = mean(ics);
  const sd = n > 1 && m !== null ? Math.sqrt(ics.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1)) : null;
  return {
    days: n, meanIC: r3(m),
    tStat: m !== null && sd ? r3(m / (sd / Math.sqrt(n)) / Math.sqrt(overlap)) : null,
    hitRate: n ? r3(ics.filter(x => x > 0).length / n) : null,
    spreadPct: r3(mean(rows.map(r => r.spread * 100))),
    upMarketIC: r3(mean(rows.filter(r => r.up === true).map(r => r.ic))),
    downMarketIC: r3(mean(rows.filter(r => r.up === false).map(r => r.ic))),
  };
}

/** `liveSince`: the day the signal was created (YYYY-MM-DD); the live period starts after it. */
export function report(u: Universe, sc: Scored, k: number, liveSince: string): SignalReport {
  const rows = dayResults(sc, k), sparse = rows.filter(r => !r.daily || isSparse(u, r.date));
  const lastYearStart = `${Number((u.dates.at(-1) ?? '0000').slice(0, 4)) - 1}${(u.dates.at(-1) ?? '').slice(4)}`;
  return { name: sc.names[k], periods: {
    learn: stats(sparse.filter(r => r.date < u.examStart)),
    exam: stats(sparse.filter(r => r.date >= u.examStart)),
    live: stats(rows.filter(r => r.date > liveSince), HORIZON),
    lastYear: stats(sparse.filter(r => r.date >= lastYearStart)),
  } };
}

/** Whether a date is on the every-fifth-day grid (daily dates in the last year are a superset). */
function isSparse(u: Universe, date: string): boolean {
  const i = u.dates.indexOf(date);
  return i >= 0 && (u.dates.length - 1 - i) % HORIZON === 0;
}

/** How alike two signals' scores are over every stock-day both scored (-1..+1). */
export function similarity(a: Scored, ka: number, b: Scored, kb: number): number | null {
  const byDate = new Map(b.points.map(p => [p.date, p]));
  const xs: number[] = [], ys: number[] = [];
  for (const p of a.points) {
    const q = byDate.get(p.date); if (!q || q.fwd.length !== p.fwd.length) continue;
    for (let s = 0; s < p.fwd.length; s++) {
      const x = p.scores[s * a.names.length + ka], y = q.scores[s * b.names.length + kb];
      if (x !== null && y !== null) { xs.push(x); ys.push(y); }
    }
  }
  return r3(pearson(xs, ys));
}

/**
 * The t-figure a new idea must reach on the exam period, given how many ideas have been tried.
 * Try 100 random ideas and about five will clear t=2 by luck; this raises the bar with each
 * idea tested (a Bonferroni correction on a two-sided 5% test).
 */
export function requiredT(ideasTested: number): number {
  const p = 0.05 / (2 * Math.max(1, ideasTested));
  // Inverse normal tail (Abramowitz–Stegun 26.2.23).
  const t = Math.sqrt(-2 * Math.log(p));
  return Math.round((t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t ** 3)) * 100) / 100;
}
