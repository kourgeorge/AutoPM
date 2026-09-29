/**
 * Cross-sectional relative-strength signal — a third family alongside `signals.ts`'s trend
 * and `meanReversion.ts`'s own-history reversion. This one is neither: it ranks each symbol's
 * recent return against the rest of today's eligible universe, so it genuinely needs
 * cross-symbol context and is computed once per day rather than per symbol.
 *
 * Sign convention matches the rest of the codebase: positive = bullish. Here that means
 * "outperformed peers over the lookback window", not "trending" or "reverted".
 */

import type { Bar } from '../core/types';
import type { SignalScore } from './signals';

export interface CrossSectionalEntry {
  symbol: string;
  bars: Bar[];
}

/**
 * Ranks each entry's `lookback`-day return against the others and maps rank linearly onto
 * -1..+1 (worst return = -1, best = +1). Entries without enough bars for a `lookback`-day
 * return are omitted from the returned map entirely — not scored 0, since "no score" and
 * "the worst in the pack" are different claims.
 */
export function crossSectionalComposite(entries: CrossSectionalEntry[], lookback = 20): Map<string, SignalScore> {
  const ranked: Array<{ symbol: string; ret: number }> = [];
  for (const entry of entries) {
    if (entry.bars.length < lookback + 1) continue;
    const last = entry.bars[entry.bars.length - 1].c;
    const prior = entry.bars[entry.bars.length - 1 - lookback].c;
    if (prior === 0) continue;
    ranked.push({ symbol: entry.symbol, ret: (last - prior) / prior });
  }

  ranked.sort((a, b) => a.ret - b.ret);
  const n = ranked.length;

  const out = new Map<string, SignalScore>();
  ranked.forEach(({ symbol, ret }, i) => {
    const score = n > 1 ? (2 * i) / (n - 1) - 1 : 0;
    out.set(symbol, {
      name: 'Cross-Sectional Rank',
      score: parseFloat(score.toFixed(2)),
      detail: `rank ${i + 1}/${n} by ${lookback}d return (${(ret * 100).toFixed(1)}%)`,
    });
  });
  return out;
}
