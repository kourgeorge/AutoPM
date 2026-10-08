import type { Bar } from '../core/types';
import { collectBars } from './barSource';
import { isUsable, type Observation } from './types';
import { ema } from '../strategy/indicators';
import { getPolicy } from '../policy/load';
import { getSectors } from './sectorCache';
import { readPositions } from '../core/accountRead';

/** Explicit comparison proxies; an ETF is not an exact model of a company's business. */
export const SECTOR_PROXIES: Record<string, string> = {
  Technology: 'XLK', Financials: 'XLF', 'Financial Services': 'XLF', Healthcare: 'XLV',
  'Consumer Cyclical': 'XLY', 'Consumer Defensive': 'XLP', Energy: 'XLE', Industrials: 'XLI',
  'Basic Materials': 'XLB', Utilities: 'XLU', 'Real Estate': 'XLRE', 'Communication Services': 'XLC',
};
const cache = new Map<string, { at: number; promise: Promise<Observation<Bar[]> | null> }>();

export async function dailyHistory(symbol: string): Promise<Observation<Bar[]> | null> {
  for (const [key, item] of cache) if (Date.now() - item.at >= 60_000) cache.delete(key);
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < 60_000) return hit.promise;
  const promise = collectBars(symbol, 85, '1Day', undefined, 'split').then(b => isUsable(b) ? b : null);
  cache.set(symbol, { at: Date.now(), promise });
  promise.then(b => { if (!b && cache.get(symbol)?.promise === promise) cache.delete(symbol); }, () => cache.delete(symbol));
  return promise;
}

export function trailingReturn(bars: Bar[], sessions: number): number | null {
  if (bars.length <= sessions) return null;
  const first = bars[bars.length - sessions - 1].c, last = bars.at(-1)!.c;
  return first > 0 ? (last / first - 1) * 100 : null;
}

/** Compare exactly the same starting and ending sessions. Missing overlap is unknown. */
export function relativeReturn(a: Bar[], b: Bar[], sessions = 20, since?: string) {
  const aa = new Map(a.map(x => [x.t.slice(0, 10), x.c])), bb = new Map(b.map(x => [x.t.slice(0, 10), x.c]));
  const dates = [...aa.keys()].filter(d => bb.has(d)).sort();
  if (a.at(-1)?.t.slice(0, 10) !== b.at(-1)?.t.slice(0, 10)) return null;
  const window = since ? dates.filter(d => d >= since.slice(0, 10)) : dates.slice(-(sessions + 1));
  if (window.length < (since ? 2 : sessions + 1)) return null;
  const from = window[0], to = window.at(-1)!;
  const returnPct = (aa.get(to)! / aa.get(from)! - 1) * 100;
  const benchmarkReturnPct = (bb.get(to)! / bb.get(from)! - 1) * 100;
  if (![returnPct, benchmarkReturnPct].every(Number.isFinite)) return null;
  return { from, to, observations: window.length, returnPct, benchmarkReturnPct, excessPct: returnPct - benchmarkReturnPct };
}

export async function relativeContext(symbol: string, since?: string) {
  const sectors = await getSectors([symbol]), sector = sectors[symbol], sectorProxy = sector ? SECTOR_PROXIES[sector] ?? null : null;
  const histories = await Promise.allSettled([dailyHistory(symbol), dailyHistory('SPY'), sectorProxy ? dailyHistory(sectorProxy) : null]);
  const [own, market, sectorBars] = histories.map(r => r.status === 'fulfilled' ? r.value : null);
  return { symbol, asOf: own?.asOf ?? null, source: own?.source ?? 'unavailable', sector, sectorProxy,
    market20d: own && market ? relativeReturn(own.value, market.value) : null,
    sector20d: own && sectorBars ? relativeReturn(own.value, sectorBars.value) : null,
    marketSinceEntry: since && own && market ? relativeReturn(own.value, market.value, 20, since) : null,
    caveats: ['Returns use split-adjusted completed closes; dividends are excluded. Sector ETFs are comparison proxies.',
      ...(since ? ['Since-entry comparison starts at the first shared completed close on or after entry, not the intraday fill.'] : []),
      ...(!own || !market ? ['Fresh relative-performance history is unavailable.'] : [])] };
}

export async function marketContext() {
  const held = await readPositions();
  const universe = [...new Set([...getPolicy().strategy.watchlist, ...held.map(p => p.symbol)])];
  const proxies = [...new Set(['SPY', 'QQQ', 'IWM', ...Object.values(SECTOR_PROXIES)])];
  const histories = new Map(await Promise.all([...new Set([...universe, ...proxies])].map(async s => [s, await dailyHistory(s).catch(() => null)] as const)));
  const sectors = await getSectors(universe);
  const rows = universe.map(symbol => {
    const h = histories.get(symbol), bars = h?.value ?? [], average = ema(bars.map(b => b.c), 50).at(-1);
    const last = bars.at(-1)?.c ?? null;
    return { symbol, sector: sectors[symbol], asOf: h?.asOf ?? null, source: h?.source ?? null,
      return1dPct: trailingReturn(bars, 1), return5dPct: trailingReturn(bars, 5), return20dPct: trailingReturn(bars, 20),
      aboveEma50: bars.length >= 50 && average != null && last != null ? last > average : null };
  });
  const trendMeasured = rows.filter(r => r.aboveEma50 != null), dailyMeasured = rows.filter(r => r.return1dPct != null);
  const benchmarkRows = proxies.map(symbol => { const h = histories.get(symbol), b = h?.value ?? []; return {
    symbol, asOf: h?.asOf ?? null, source: h?.source ?? null, return1dPct: trailingReturn(b, 1), return5dPct: trailingReturn(b, 5),
    return20dPct: trailingReturn(b, 20), return60dPct: trailingReturn(b, 60) }; });
  return { asOf: benchmarkRows.find(r => r.symbol === 'SPY')?.asOf ?? null, source: 'derived', universe,
    breadth: { scope: 'Approved watchlist plus current holdings; this is not exchange-wide market breadth', total: universe.length,
      trendMeasured: trendMeasured.length, aboveEma50Pct: trendMeasured.length ? trendMeasured.filter(r => r.aboveEma50).length / trendMeasured.length * 100 : null,
      dailyMeasured: dailyMeasured.length, advancingPct: dailyMeasured.length ? dailyMeasured.filter(r => r.return1dPct! > 0).length / dailyMeasured.length * 100 : null },
    benchmarks: benchmarkRows, rows, caveats: ['Split-adjusted completed sessions, excluding dividends.', 'Missing histories remain null and are excluded from breadth denominators.'] };
}
