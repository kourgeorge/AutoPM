import { collectBars } from '../collect/barSource';
import { isPresent } from '../collect/types';
import { lastCompletedSession } from '../collect/marketCalendar';
import { getSectors } from '../collect/sectorCache';
import type { Policy } from '../policy/types';
import { hasRiskProfile } from '../policy/riskProfiles';
import type { Bar } from '../core/types';
import { VOLATILITY_LOOKBACK, type RiskInputs } from './riskBudget';

const cache = new Map<string, { at: number; session: string; promise: Promise<Bar[]> }>();
const CACHE_MS = 5 * 60_000;

/** Cache daily histories, never account weights. Recheck the completed session on every read. */
export async function collectRiskInputs(symbols: string[], policy: Policy): Promise<RiskInputs> {
  const unique = [...new Set(symbols)];
  const inputs: RiskInputs = { histories: {}, sectors: {}, asOf: null, errors: {} };
  if (!hasRiskProfile(policy.risk)) return inputs;
  const sectorPromise = getSectors(unique).then(sectors => { inputs.sectors = sectors; }).catch(() => {
    // The sizing engine uses the worst possible overlap for unknown sectors.
    inputs.sectors = Object.fromEntries(unique.map(s => [s, null]));
  });
  if (policy.risk.targetVolatilityPct != null) {
    try {
      inputs.asOf = (await lastCompletedSession()).date;
      const session = inputs.asOf;
      await Promise.all(unique.map(async symbol => {
        try {
          let hit = cache.get(symbol);
          if (!hit || hit.session !== session || Date.now() - hit.at > CACHE_MS) {
            // A split changes share units, not economic volatility. Yahoo's fallback daily
            // close series also adjusts for splits; request the same convention from Alpaca.
            const promise = collectBars(symbol, VOLATILITY_LOOKBACK + 5, '1Day', undefined, 'split').then(bars => {
              if (!isPresent(bars) || bars.stale) throw new Error('Fresh daily history unavailable');
              if (!bars.value.some(b => b.t.slice(0, 10) === session)) throw new Error(`Daily history does not reach ${session}`);
              return bars.value;
            });
            hit = { at: Date.now(), session, promise };
            cache.set(symbol, hit);
            promise.catch(() => { if (cache.get(symbol)?.promise === promise) cache.delete(symbol); });
          }
          inputs.histories[symbol] = await hit.promise;
        } catch (err) { inputs.errors[symbol] = err instanceof Error ? err.message : String(err); }
      }));
    } catch (err) { inputs.errors.calendar = err instanceof Error ? err.message : String(err); }
  }
  await sectorPromise;
  // Bound the process cache even when a long-lived worker's watchlist keeps changing.
  if (cache.size > 200) for (const [symbol, hit] of cache) if (Date.now() - hit.at > CACHE_MS) cache.delete(symbol);
  return inputs;
}
