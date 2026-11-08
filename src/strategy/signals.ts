/**
 * The trend composite and its readers' helpers.
 *
 * The signals themselves live in `src/signals/` as classes (one `Signal` per measurement,
 * listed in `signals/registry.ts`). This file keeps the functions the rest of the engine has
 * always called, so the tick, the entry gate, the backtest and the trader tools did not have
 * to change when the signals became classes:
 *
 *   computeSignals        every trend signal, built-in plus promoted learned ones
 *   builtInTrendSignals   the five hand-written ones only
 *   signalTally           counts and the weighted composite
 *   signalSummary         the one-line headline
 *
 * The idea of scoring several signals and letting the trader weigh them comes from Ang,
 * Azimbayev & Kim (2026) "The Self-Driving Portfolio"; the trader LLM is the judge.
 */

import type { Bar } from '../core/types';
import type { Policy } from '../policy/types';
import { scoreAll, signalsIn, signalWeights } from '../signals/registry';

export type { SignalScore } from '../signals/signal';
import type { SignalScore } from '../signals/signal';

/**
 * Every trend signal for a symbol's bars: the five built-ins, then any model-written signal
 * the learning layer promoted (named "Learned: …"). Deterministic for the built-ins.
 */
export function computeSignals(bars: Bar[], policy: Policy): SignalScore[] {
  return scoreAll(signalsIn('trend'), bars, policy);
}

/** The five hand-written trend signals only — what the learning layer measures as built-ins. */
export function builtInTrendSignals(bars: Bar[], policy: Policy): SignalScore[] {
  return scoreAll(signalsIn('trend', { learned: false }), bars, policy);
}

export interface SignalTally {
  bullish: number;
  bearish: number;
  neutral: number;
  total: number;
  /**
   * Mean of the raw scores, -1..+1, or null when nothing was scored.
   *
   * The number to act on. The vote counts above pass a score of +0.15 and a score of +0.95
   * through the same dead band, so "3/5 bullish" is identical for a barely-positive tape and a
   * screaming one; the composite keeps the magnitude the five signals actually produced.
   * Rounded here, once, so no reader has to decide how much precision a mean of five 2dp
   * numbers deserves.
   */
  composite: number | null;
}

/**
 * The five scores reduced two ways: how many lean which way, and what they average to.
 *
 * Exported on purpose. Both readings are judgements rather than arithmetic facts — the dead
 * band that decides "bullish", and the choice to weight the five equally in the mean — and
 * `> 0.1` used to be inlined in `signalSummary` alone, so the terminal dashboard, which wants
 * the same verdict in three columns rather than a sentence, would have had to restate it and
 * become a second, silently divergent truth about the same five numbers. One owner, many
 * renderings.
 *
 * The counts are kept because a reader still wants to know whether the mean came from broad
 * agreement or from one extreme score dragging four neutrals; they are context for the
 * composite, not a substitute for it.
 */
export function signalTally(signals: SignalScore[]): SignalTally {
  let bullish = 0;
  let bearish = 0;
  let neutral = 0;
  let sum = 0;
  let weighted = 0;
  let weightTotal = 0;
  const signalWeight = signalWeights();

  for (const s of signals) {
    if (s.score > 0.1) bullish++;
    else if (s.score < -0.1) bearish++;
    else neutral++;
    sum += s.score;
    // Learned weights (`signals/registry.ts`); every signal counts 1 until the learning layer
    // has measured it, which is the plain mean this used to be.
    const w = signalWeight(s.name);
    weighted += w * s.score;
    weightTotal += w;
  }

  // Null, not 0: an unscored symbol and a symbol whose signals cancel out are different
  // claims, and 0 would read as the second.
  const composite = signals.length === 0
    ? null
    : parseFloat((weightTotal > 0 ? weighted / weightTotal : sum / signals.length).toFixed(3));

  return { bullish, bearish, neutral, total: signals.length, composite };
}

/**
 * One-line summary: "composite +0.42 - 3/5 bullish, 1 neutral, 1 bearish"
 *
 * Composite first, because it is the number TRADER.md thresholds on and the counts are its
 * context. No surrounding parentheses: callers wrap this themselves (the `entry_signal`
 * headline appends it in brackets), and a self-parenthesising summary nested inside those
 * produced `((composite ...))`.
 */
export function signalSummary(signals: SignalScore[]): string {
  const { bullish, bearish, neutral, composite } = signalTally(signals);

  const parts: string[] = [];
  if (bullish > 0) parts.push(`${bullish}/${signals.length} bullish`);
  if (neutral > 0) parts.push(`${neutral} neutral`);
  if (bearish > 0) parts.push(`${bearish} bearish`);

  const lean = parts.join(', ');
  if (composite === null) return lean;
  return `composite ${composite >= 0 ? '+' : ''}${composite.toFixed(2)}${lean ? ` - ${lean}` : ''}`;
}
