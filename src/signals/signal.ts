/**
 * The one shape every signal has.
 *
 * A signal reads the daily bars of one stock, up to and including the day being scored, and
 * says how favourable that stock looks for a long entry: a score from -1 (strongly bearish)
 * to +1 (strongly bullish), and one line explaining it. Built-in signals and model-written
 * ones (`sandboxed.ts`) are both `Signal`s, so the trader's composite, the backtest and the
 * learning layer treat them the same way.
 *
 * Writing a new one:
 *
 *   export class GapUp extends Signal {
 *     readonly id = 'gap-up';  readonly name = 'Gap Up';  readonly family = 'trend';
 *     readonly minBars = 2;
 *     readonly description = 'Today opened above yesterday's high.';
 *     protected compute({ bars, last }: SignalContext): Reading {
 *       const gap = last.o / bars[bars.length - 2].h - 1;
 *       return { score: gap * 20, detail: `gap ${(gap * 100).toFixed(1)}%` };
 *     }
 *   }
 *
 * then add it to `registry.ts` and run `npm run signal -- gap-up`. Everything else — not
 * enough bars, keeping the score in range, rounding, turning a crash into "no reading" — is
 * done here, once, so a new signal states only what it measures. `tests/signals.test.cjs`
 * holds every registered signal to the same rules automatically.
 *
 * Sign convention, for every family: positive = good for a long entry.
 */
import type { Bar } from '../core/types';
import type { Policy } from '../policy/types';
import { adx, atr, ema, macd, rsi, type MACDResult } from '../strategy/indicators';

export type SignalFamily = 'trend' | 'meanReversion';

/** The public result. Unchanged from before the classes, so every reader keeps working. */
export interface SignalScore {
  name: string;
  score: number;   // -1 to +1
  detail: string;  // one-line explanation
}

/** What `compute` returns: a raw score (clamped and rounded for you) or "no reading". */
export interface Reading { score: number; detail: string }
export type NoReading = { score: null; detail: string };

/**
 * Bars plus the indicator series signals keep asking for, worked out on first use and then
 * shared, so five signals that all want RSI(14) compute it once per stock per tick.
 */
export class SignalContext {
  readonly closes: number[];
  private readonly memo = new Map<string, unknown>();
  constructor(readonly bars: readonly Bar[], readonly policy: Policy) {
    this.closes = bars.map(b => b.c);
  }
  get last(): Bar { return this.bars[this.bars.length - 1]; }
  /** Any value keyed by name, computed once for this context. */
  cached<T>(key: string, make: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, make());
    return this.memo.get(key) as T;
  }
  ema(period: number): number[] { return this.cached(`ema:${period}`, () => ema(this.closes, period)); }
  rsi(period = this.policy.strategy.rsiPeriod): number[] { return this.cached(`rsi:${period}`, () => rsi(this.closes, period)); }
  atr(period = this.policy.strategy.atrPeriod): number[] { return this.cached(`atr:${period}`, () => atr(this.bars as Bar[], period)); }
  adx(period = 14): number[] { return this.cached(`adx:${period}`, () => adx(this.bars as Bar[], period)); }
  macd(fast = 12, slow = 26, signal = 9): MACDResult | null { return this.cached(`macd:${fast}:${slow}:${signal}`, () => macd(this.closes, fast, slow, signal)); }
}

export const clamp = (x: number, lo = -1, hi = 1): number => Math.max(lo, Math.min(hi, x));
const round2 = (x: number): number => parseFloat(x.toFixed(2));

export abstract class Signal {
  /** Stable key: weights, test results and the learning record are stored under it. */
  abstract readonly id: string;
  /** What people and the trader see. Weights are also looked up by it, as before. */
  abstract readonly name: string;
  abstract readonly family: SignalFamily;
  /** Bars needed before `compute` is called. Fewer gives score 0, "insufficient data". */
  abstract readonly minBars: number;
  /** One sentence: what it measures and why it might predict anything. */
  abstract readonly description: string;
  /** Who wrote it. Model-written signals say 'learned'. */
  readonly origin: 'built-in' | 'learned' = 'built-in';

  /** Work out the reading. May assume `minBars` bars. Do not round or clamp. */
  protected abstract compute(ctx: SignalContext): Reading | NoReading;

  /**
   * Score one stock on its newest bar. Never throws.
   * `null` means the signal has nothing to say; a built-in reports a 0 score instead, as it always has.
   */
  evaluate(ctx: SignalContext): SignalScore | null {
    if (ctx.bars.length < this.minBars) return { name: this.name, score: 0, detail: this.insufficient(ctx) };
    let r: Reading | NoReading;
    try { r = this.compute(ctx); }
    catch (err) { return this.origin === 'built-in' ? { name: this.name, score: 0, detail: `could not score: ${err instanceof Error ? err.message : String(err)}` } : null; }
    if (r.score === null || !Number.isFinite(r.score)) return this.origin === 'built-in' ? { name: this.name, score: 0, detail: r.detail } : null;
    return { name: this.name, score: round2(clamp(r.score)), detail: r.detail };
  }

  /** The text used when there are too few bars. Overridable so existing wording is kept. */
  protected insufficient(_ctx: SignalContext): string { return 'insufficient data'; }

  /** Convenience for one-off calls; prefer sharing one context across signals. */
  score(bars: readonly Bar[], policy: Policy): SignalScore | null { return this.evaluate(new SignalContext(bars, policy)); }
}
