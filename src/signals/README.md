# Signals

Every signal is one class. Built-in signals and AI-written ones share the same interface, so
the trader's combined score, the backtest and the learning layer all treat them the same way.

```
signal.ts          Signal base class, SignalContext (bars + shared indicators), SignalScore
registry.ts        which signals exist, by family; promoted AI signals; weights
builtin/           the hand-written signals (trend, meanReversion, crossSectional)
sandboxed.ts       an AI-written signal: its code runs in learning/sandbox.ts
testkit.ts         the rules every signal must pass
```

## Adding a signal

1. Write the class in `builtin/<family>.ts`:

   ```ts
   export class GapUp extends Signal {
     readonly id = 'gap-up';            // lower-case-with-dashes, never reused
     readonly name = 'Gap Up';          // what the trader and dashboard show
     readonly family = 'trend';         // 'trend' feeds the entry gate's combined score
     readonly minBars = 2;              // fewer bars → score 0, "insufficient data"
     readonly description = "Today's open against yesterday's high.";
     protected compute({ bars, last }: SignalContext): Reading {
       const gap = last.o / bars[bars.length - 2].h - 1;
       return { score: gap * 20, detail: `gap ${(gap * 100).toFixed(1)}%` };
     }
   }
   ```

   Return the raw score: the base class keeps it between -1 and +1 and rounds it. Positive
   always means good for a long entry. Use `ctx.ema(n)`, `ctx.rsi()`, `ctx.atr()`, `ctx.adx()`,
   `ctx.macd()` or `ctx.cached(key, fn)` so indicators are worked out once per stock.

2. Add it to the family's list (`TREND_SIGNALS` or `MEAN_REVERSION_SIGNALS`).

3. `node --test tests/signals.test.cjs` runs the shared rules on it automatically: score in
   range, the same answer every time, it doesn't change its input, short history, odd data
   (flat prices, zero volume, spikes), and speed.

4. `npm run signal -- gap-up` grades it on ten years of prices for about 56 stocks: how well its
   score ranked them by their next five trading days, on older years and on the last two.

## Before it should count

A new built-in joins the combined score immediately, at weight 1. Only add it if
`npm run signal` shows a positive IC with t ≥ 2 on **both** periods. Otherwise it adds noise
to the entry gate. The learning layer then adjusts its weight over time like any other.

Changing an existing signal's maths changes live trading. `tests/fixtures/signals/` pins the
current outputs on 124 real windows; update that fixture only on purpose.
