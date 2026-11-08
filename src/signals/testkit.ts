/**
 * The rules every signal must follow, checked the same way for all of them.
 *
 * `tests/signals.test.cjs` runs `checkSignal` on every registered signal, so a new signal is
 * tested the moment it is added to the registry, with no test of its own needed. A signal
 * can add its own tests for its particular logic; these are the shared minimum:
 *
 *   in range        every score is a finite number from -1 to +1
 *   repeatable      the same bars give the same answer
 *   no side effects it does not change the bars it was given
 *   short history   fewer than minBars bars gives a plain "insufficient data" reading
 *   odd data        flat prices, zero volume, gaps and spikes do not crash it
 *   well described  it has an id, name, family and a one-sentence description
 *   live speed      one score takes well under a millisecond on average
 *
 * Peeking at the future needs no check: a signal is only ever handed bars up to the day
 * being scored (`SignalContext`, and `learning/evaluate.ts` slices the same way), so there is
 * nothing later for it to read.
 *
 * Bars here are generated, not real: a seeded random walk, so failures reproduce exactly.
 */
import type { Bar } from '../core/types';
import type { Policy } from '../policy/types';
import { Signal, SignalContext } from './signal';

export interface CheckResult { ok: boolean; failures: string[] }

/** A seeded random walk with realistic open/high/low/close/volume shapes. */
export function syntheticBars(n: number, seed = 1, opts: { drift?: number; vol?: number; flat?: boolean; zeroVolume?: boolean; spikes?: boolean } = {}): Bar[] {
  let s = seed >>> 0 || 1;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const out: Bar[] = [];
  let price = 100;
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    const open = price;
    const move = opts.flat ? 0 : (opts.drift ?? 0) + (rand() - 0.5) * 2 * (opts.vol ?? 0.02) + (opts.spikes && i % 37 === 0 ? (rand() < 0.5 ? -0.25 : 0.3) : 0);
    price = Math.max(0.5, price * (1 + move));
    const hi = Math.max(open, price) * (1 + (opts.flat ? 0 : rand() * 0.01));
    const lo = Math.min(open, price) * (1 - (opts.flat ? 0 : rand() * 0.01));
    out.push({ t: new Date(start + i * 86_400_000).toISOString(), o: open, h: hi, l: lo, c: price, v: opts.zeroVolume ? 0 : Math.round(1e6 * (0.5 + rand())) });
  }
  return out;
}

export function checkSignal(signal: Signal, policy: Policy): CheckResult {
  const failures: string[] = [];
  const fail = (rule: string, why: string) => failures.push(`${signal.id}: ${rule} — ${why}`);
  const score = (bars: Bar[]) => signal.evaluate(new SignalContext(bars, policy));

  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(signal.id)) fail('well described', `id "${signal.id}" must be lower-case words joined by dashes`);
  if (!signal.name.trim()) fail('well described', 'has no name');
  if (!['trend', 'meanReversion'].includes(signal.family)) fail('well described', `unknown family ${signal.family}`);
  if (signal.description.trim().length < 10) fail('well described', 'needs a one-sentence description');
  if (!Number.isInteger(signal.minBars) || signal.minBars < 0 || signal.minBars > 250) fail('well described', `minBars ${signal.minBars} must be a whole number 0–250`);

  const series = [
    ['random walk', syntheticBars(120, 11)], ['uptrend', syntheticBars(120, 12, { drift: 0.01 })], ['downtrend', syntheticBars(120, 13, { drift: -0.01 })],
    ['flat prices', syntheticBars(120, 14, { flat: true })], ['zero volume', syntheticBars(120, 15, { zeroVolume: true })],
    ['gaps and spikes', syntheticBars(120, 16, { spikes: true, vol: 0.06 })],
  ] as const;

  for (const [label, bars] of series) {
    for (const len of [signal.minBars, 30, 60, 120].filter(n => n >= 1 && n <= bars.length)) {
      const window = bars.slice(0, len);
      const before = JSON.stringify(window);
      const a = score(window);
      if (JSON.stringify(window) !== before) fail('no side effects', `${label}: it changed the bars it was given`);
      if (a === null) { if (signal.origin === 'built-in') fail('in range', `${label}: a built-in must always return a reading`); continue; }
      if (typeof a.score !== 'number' || !Number.isFinite(a.score) || a.score < -1 || a.score > 1) fail('in range', `${label}, ${len} bars: score ${a.score}`);
      if (typeof a.detail !== 'string' || !a.detail.trim()) fail('in range', `${label}: empty detail`);
      if (a.name !== signal.name) fail('in range', `${label}: reports name "${a.name}", not "${signal.name}"`);
      const b = score(window.map(x => ({ ...x })));
      if (JSON.stringify(a) !== JSON.stringify(b)) fail('repeatable', `${label}, ${len} bars: ${JSON.stringify(a)} then ${JSON.stringify(b)}`);
    }
  }

  if (signal.minBars > 1) {
    const short = score(syntheticBars(signal.minBars - 1, 31));
    if (signal.origin === 'built-in' && (!short || short.score !== 0)) fail('short history', `with ${signal.minBars - 1} bars expected score 0, got ${JSON.stringify(short)}`);
  }

  const bars = syntheticBars(60, 41);
  const runs = 300, t0 = process.hrtime.bigint();
  for (let k = 0; k < runs; k++) score(bars);
  const msEach = Number(process.hrtime.bigint() - t0) / 1e6 / runs;
  const budget = signal.origin === 'built-in' ? 1 : 5;
  if (msEach > budget) fail('live speed', `${msEach.toFixed(2)} ms per score, budget ${budget} ms`);

  return { ok: failures.length === 0, failures };
}
