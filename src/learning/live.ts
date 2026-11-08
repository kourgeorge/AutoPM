/**
 * What the learning layer has decided, as the live engine reads it.
 *
 * Two things, both saved in state by `loop.ts`:
 *   weights   how much each signal counts in the composite (missing = 1, the old equal mean)
 *   active    model-written signals that passed every test, scored live next to the built-ins
 *
 * Read on every tick through `signals.ts`, so this must stay cheap: compiled code is cached
 * by its text, and nothing here touches the network or the disk beyond the state cache.
 * Under ephemeral storage (the replay harness and tests) nothing is saved, so behaviour is
 * exactly the pre-learning equal-weight composite.
 */
import { readValue } from '../core/storage';
import type { Bar } from '../core/types';
import { compileSignal, windowAt, type CompiledSignal } from './sandbox';
import { logger } from '../core/logger';

export interface ActiveSignal { id: string; name: string; code: string }
export interface LearningLive { at: string; weights: Record<string, number>; active: ActiveSignal[] }

/** Learned signals show this prefix so nobody mistakes one for a built-in. */
export const LEARNED_PREFIX = 'Learned: ';

const compiled = new Map<string, CompiledSignal | null>();

export function learningLive(): LearningLive | null {
  try { return readValue<LearningLive>('learningLive') ?? null; } catch { return null; }
}

/** Returns a lookup for one composite: reads the saved weights once, not once per signal. */
export function signalWeights(): (name: string) => number {
  let weights: Record<string, number> | undefined;
  try { weights = readValue<Record<string, number>>('learningWeights'); } catch { weights = undefined; }
  return name => {
    const w = weights?.[name];
    return typeof w === 'number' && Number.isFinite(w) && w >= 0 ? w : 1;
  };
}
export const signalWeight = (name: string): number => signalWeights()(name);

/** Scores of the active learned signals for the newest bar. A failing signal is skipped, not fatal. */
export function learnedSignalScores(bars: Bar[]): { name: string; score: number; detail: string }[] {
  const live = learningLive();
  if (!live?.active?.length || bars.length < 30) return [];
  const out: { name: string; score: number; detail: string }[] = [];
  for (const s of live.active) {
    let c = compiled.get(s.code);
    if (c === undefined) {
      try { c = compileSignal(s.code); } catch (err: any) { logger.warn(`[Learning] ${s.name} will not compile: ${err.message}`); c = null; }
      compiled.set(s.code, c);
    }
    if (!c) continue;
    try {
      const [v] = c.run([windowAt(bars, bars.length - 1)], 250);
      if (v !== null) out.push({ name: LEARNED_PREFIX + s.name, score: Math.round(v * 100) / 100, detail: `model-written signal ${s.id}, weight ${signalWeight(LEARNED_PREFIX + s.name).toFixed(2)}` });
    } catch { /* one bad reading never blocks the tick */ }
  }
  return out;
}
