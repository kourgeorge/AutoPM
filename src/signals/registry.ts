/**
 * Which signals exist, and how a family of them becomes one composite.
 *
 * Built-ins are listed here in code. Learned signals come from the learning layer's saved
 * state (`learningLive.active`) and join the trend family, the one the entry gate reads.
 * Weights come from `learningWeights`; a signal with no saved weight counts 1, which makes
 * the composite exactly the plain mean it was before the learning layer.
 *
 * Under ephemeral storage (the replay harness, tests) nothing is saved, so only built-ins
 * count and all weights are 1.
 */
import type { Bar } from '../core/types';
import type { Policy } from '../policy/types';
import { readValue } from '../core/storage';
import { Signal, SignalContext, type SignalFamily, type SignalScore } from './signal';
import { TREND_SIGNALS } from './builtin/trend';
import { MEAN_REVERSION_SIGNALS } from './builtin/meanReversion';
import { SandboxedSignal } from './sandboxed';

export const BUILT_IN_SIGNALS: readonly Signal[] = [...TREND_SIGNALS, ...MEAN_REVERSION_SIGNALS];

interface SavedLearned { id: string; name: string; code: string; idea?: string }
const learnedCache = new Map<string, SandboxedSignal>();

/** Promoted model-written signals, rebuilt only when their saved code changes. */
export function learnedSignals(): SandboxedSignal[] {
  let saved: SavedLearned[] = [];
  try { saved = readValue<{ active?: SavedLearned[] }>('learningLive')?.active ?? []; } catch { /* no storage: none */ }
  return saved.map(s => {
    const key = s.id + '\0' + s.code;
    let sig = learnedCache.get(key);
    if (!sig) { sig = new SandboxedSignal(s.id, s.name, s.code, s.idea ?? 'model-written signal'); learnedCache.set(key, sig); }
    return sig;
  });
}

/** Every signal in a family, built-ins first. `learned: false` gives the hand-written ones only. */
export function signalsIn(family: SignalFamily, opts: { learned?: boolean } = {}): Signal[] {
  const built = BUILT_IN_SIGNALS.filter(s => s.family === family);
  return opts.learned === false ? built : [...built, ...learnedSignals().filter(s => s.family === family)];
}

export function findSignal(idOrName: string): Signal | undefined {
  const key = idOrName.toLowerCase();
  return [...BUILT_IN_SIGNALS, ...learnedSignals()].find(s => s.id.toLowerCase() === key || s.name.toLowerCase() === key);
}

/** Score one stock with a list of signals, sharing one context so indicators are computed once. */
export function scoreAll(signals: readonly Signal[], bars: readonly Bar[], policy: Policy): SignalScore[] {
  const ctx = new SignalContext(bars, policy);
  const out: SignalScore[] = [];
  for (const s of signals) { const r = s.evaluate(ctx); if (r) out.push(r); }
  return out;
}

/** Reads the saved weights once and returns a lookup; missing or invalid = 1. */
export function signalWeights(): (name: string) => number {
  let weights: Record<string, number> | undefined;
  try { weights = readValue<Record<string, number>>('learningWeights'); } catch { weights = undefined; }
  return name => {
    const w = weights?.[name];
    return typeof w === 'number' && Number.isFinite(w) && w >= 0 ? w : 1;
  };
}
