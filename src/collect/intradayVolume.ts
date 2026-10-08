import { alpacaData, SIP_EMBARGO_MS } from '../core/alpacaHttp';
import { etNow } from '../core/time';

interface VolumeBar { t: string; v: number }
/** Compare completed five-minute bins against the same ET bins on prior sessions. */
export function relativeIntradayVolume(bars: VolumeBar[], end: Date, sessions = 20) {
  const nowEt = etNow(end), cutoff = Math.min(960, nowEt.hours * 60 + nowEt.minutes);
  const groups = new Map<string, Map<number, number>>();
  for (const bar of bars) {
    const t = Date.parse(bar.t);
    if (!Number.isFinite(t) || t + 5 * 60000 > end.getTime() || !Number.isFinite(bar.v) || bar.v < 0) continue;
    const et = etNow(new Date(t)), minute = et.hours * 60 + et.minutes;
    if (minute < 570 || minute + 5 > cutoff || minute >= 960) continue;
    if (!groups.has(et.date)) groups.set(et.date, new Map());
    groups.get(et.date)!.set(minute, bar.v);
  }
  const current = groups.get(nowEt.date), expectedBins = Math.max(0, Math.floor((cutoff - 570) / 5));
  // Exact bin matching makes gaps and half-days visible instead of lowering the denominator.
  const complete = (g: Map<number, number>) => expectedBins > 0 && Array.from({ length: expectedBins }, (_, i) => 570 + i * 5).every(m => g.has(m));
  const prior = [...groups].filter(([day, g]) => day < nowEt.date && complete(g)).sort(([a], [b]) => a.localeCompare(b)).slice(-sessions);
  const sum = (g: Map<number, number>) => [...g.values()].reduce((a, b) => a + b, 0);
  const today = current && complete(current) ? sum(current) : null;
  const average = prior.length ? prior.reduce((a, [, g]) => a + sum(g), 0) / prior.length : null;
  return { session: nowEt.date, cutoffEtMinutes: cutoff, measuredPriorSessions: prior.length, currentVolume: today, averageMatchedVolume: average,
    relativeVolume: today != null && average != null && average > 0 && prior.length >= 5 ? today / average : null,
    caveats: ["Only regular-session, completed five-minute bins are compared. Sessions with missing bins or earlier closes are excluded.",
      ...(today == null ? ['Current-session volume coverage is incomplete.'] : []), ...(prior.length < 5 ? ['Fewer than five comparable sessions; relative volume is unknown.'] : [])] };
}

export async function getIntradayVolume(symbol: string) {
  const end = new Date(Date.now() - SIP_EMBARGO_MS), bars: VolumeBar[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await alpacaData.get('/v2/stocks/bars', { params: { symbols: symbol, timeframe: '5Min',
      start: new Date(end.getTime() - 45 * 86400000).toISOString(), end: end.toISOString(), limit: 10000, adjustment: 'split',
      ...(pageToken ? { page_token: pageToken } : {}) } });
    bars.push(...(res.data?.bars?.[symbol] ?? []));
    pageToken = res.data?.next_page_token ?? undefined;
    if (!pageToken) return { symbol, asOf: end.toISOString(), source: 'alpaca', feed: 'subscription default', ...relativeIntradayVolume(bars, end),
      delayMinutes: SIP_EMBARGO_MS / 60000 };
  }
  throw new Error('Intraday history exceeds pagination budget; no partial volume comparison was returned');
}
