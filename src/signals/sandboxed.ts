/**
 * A model-written signal, behind the same `Signal` interface as the built-ins.
 *
 * The code itself runs in the sandbox (`learning/sandbox.ts`): it receives plain price arrays
 * and returns one number. Compiling happens once per distinct code text and is shared.
 * A failing or silent reading is "no reading" (`null`), never a 0 that would drag the
 * composite toward neutral.
 *
 * Centring: the learning layer grades a learned signal on rank order only, so its raw scale
 * says nothing — one that ranks well but always returns 0.5..1.0 would lift every stock's
 * composite past the entry floor. So the live score is centred and scaled with the median
 * and spread (MAD) the learning run measured on it (`scale` in `learningLive.active`):
 * (raw - median) / (3 × MAD), clipped to -1..+1. A promoted record saved before this existed
 * has no `scale` until the next learning run; until then it counts only if its median over
 * this stock's own recent history is near 0, and is otherwise left out (with a log line).
 */
import { compileSignal, windowAt, type CompiledSignal, type BarArrays } from '../learning/sandbox';
import { readValue } from '../core/storage';
import { logger } from '../core/logger';
import { Signal, type SignalContext, type Reading, type NoReading, type SignalFamily } from './signal';

/** Learned signals carry this prefix so nobody mistakes one for a built-in. */
export const LEARNED_PREFIX = 'Learned: ';

const compiled = new Map<string, CompiledSignal | Error>();
function compiledFor(code: string): CompiledSignal {
  let c = compiled.get(code);
  if (!c) { try { c = compileSignal(code); } catch (err) { c = err instanceof Error ? err : new Error(String(err)); } compiled.set(code, c); }
  if (c instanceof Error) throw c;
  return c;
}

/** Median and median absolute deviation of a learned signal's raw scores over its learning period. */
export interface ScoreScale { median: number; spread: number }

/** How far a missing-scale signal's median may sit from 0 and still count uncentred. */
export const NEAR_ZERO_MEDIAN = 0.1;

/** Raw score → centred score, clipped to -1..+1. A spread of 0 (near-constant signal) only centres. */
export function centreScore(raw: number, scale: ScoreScale): number {
  const width = scale.spread > 1e-9 ? 3 * scale.spread : 1;
  return Math.max(-1, Math.min(1, (raw - scale.median) / width));
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function savedScale(id: string): ScoreScale | null {
  let active: { id: string; scale?: ScoreScale }[] = [];
  try { active = readValue<{ active?: { id: string; scale?: ScoreScale }[] }>('learningLive')?.active ?? []; } catch { /* no storage */ }
  const s = active.find(a => a.id === id)?.scale;
  return s && Number.isFinite(s.median) && Number.isFinite(s.spread) ? s : null;
}

/** Signals without a saved scale already judged this process (id → counts uncentred?). */
const unscaledVerdict = new Map<string, boolean>();

export class SandboxedSignal extends Signal {
  readonly name: string;
  readonly family: SignalFamily = 'trend';
  readonly minBars = 30;
  readonly origin = 'learned' as const;
  constructor(readonly id: string, readonly label: string, readonly code: string, readonly description: string, private readonly timeoutMs = 250) {
    super();
    this.name = LEARNED_PREFIX + label;
  }
  protected compute({ bars }: SignalContext): Reading | NoReading {
    const [v] = compiledFor(this.code).run([windowAt(bars as any, bars.length - 1)], this.timeoutMs);
    if (v === null) return { score: null, detail: 'no reading' };
    const scale = savedScale(this.id);
    if (scale) return { score: centreScore(v, scale), detail: `model-written signal ${this.id} (raw ${v.toFixed(3)}, centred on ${scale.median.toFixed(3)})` };
    let ok = unscaledVerdict.get(this.id);
    if (ok === undefined) {
      const windows: BarArrays[] = [];
      for (let i = this.minBars - 1; i < bars.length; i++) windows.push(windowAt(bars as any, i));
      const m = median(this.runMany(windows, this.timeoutMs * 4).filter((x): x is number => x !== null));
      ok = m !== null && Math.abs(m) <= NEAR_ZERO_MEDIAN;
      unscaledVerdict.set(this.id, ok);
      if (!ok) logger.info(`[Learning] ${this.name} left out of the composite until the next learning run measures its centre (median ${m === null ? 'unknown' : m.toFixed(3)} is not near 0)`);
    }
    return ok ? { score: v, detail: `model-written signal ${this.id} (no saved centre yet; median near 0)` } : { score: null, detail: 'left out until its centre is measured' };
  }
  /** Many windows in one sandbox call — what the learning layer uses over ten years of history. */
  runMany(windows: BarArrays[], timeoutMs = 20_000): (number | null)[] { return compiledFor(this.code).run(windows, timeoutMs); }
}
