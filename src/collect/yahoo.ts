import { Bar } from '../core/types';

// yahoo-finance2 v4 requires instantiation
// eslint-disable-next-line @typescript-eslint/no-require-imports
const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

export interface RawQuote {
  price: number;
  /** Exchange timestamp of the quote, if the feed reported one. */
  asOf?: string;
}

/**
 * Fetch a quote, THROWING on failure and on a missing price.
 * Use this from `src/collect/` where the error must be preserved as provenance.
 */
export async function getQuoteRaw(symbol: string): Promise<RawQuote> {
  // validateResult:false — Yahoo's response shape drifts per symbol; a schema
  // miss otherwise logs a wall of text and throws even when the price is fine.
  // The checks below are the real validation.
  const quote = await yf.quote(symbol, {}, { validateResult: false }) as any;
  const price = quote?.regularMarketPrice ?? quote?.postMarketPrice ?? quote?.preMarketPrice;
  if (typeof price !== 'number' || !Number.isFinite(price)) {
    throw new Error(`${symbol}: no usable price in quote response`);
  }
  const t = quote?.regularMarketTime;
  const asOf = t instanceof Date
    ? t.toISOString()
    : typeof t === 'number'
      ? new Date(t * 1000).toISOString()
      : undefined;
  return { price, asOf };
}

/**
 * Fetch the GICS-style sector for a symbol, or `null` when Yahoo does not report one.
 *
 * `null` is a legitimate answer, not an error: ETFs have no `assetProfile.sector`, and a
 * book that is mostly ETFs must read as "sector unknown" rather than as a failed call.
 * A throw is also `null` — never a guess from the ticker.
 *
 * validateResult:false for the reason in `getQuoteRaw` — `assetProfile` is one of the
 * shapes that drifts most, and a schema miss would throw away a sector that is present.
 */
export async function getSectorRaw(symbol: string): Promise<string | null> {
  try {
    const r = await yf.quoteSummary(
      symbol,
      { modules: ['assetProfile'] },
      { validateResult: false },
    ) as any;
    const sector = r?.assetProfile?.sector;
    return typeof sector === 'string' && sector.length > 0 ? sector : null;
  } catch {
    return null;
  }
}

export type Timeframe = '1Min' | '5Min' | '15Min' | '1Hour' | '1Day';

// Yahoo interval + trading bars per calendar day (used to estimate lookback range)
const TF_MAP: Record<Timeframe, { interval: string; barsPerDay: number }> = {
  '1Min':  { interval: '1m',  barsPerDay: 390 },
  '5Min':  { interval: '5m',  barsPerDay: 78  },
  '15Min': { interval: '15m', barsPerDay: 26  },
  '1Hour': { interval: '60m', barsPerDay: 7   },
  '1Day':  { interval: '1d',  barsPerDay: 1   },
};

/**
 * Fetch bars, THROWING on failure and on an empty series.
 * Use this from `src/collect/` where the error must be preserved as provenance.
 */
export async function getBarsRaw(
  symbol: string,
  limit = 60,
  timeframe: Timeframe = '1Day',
): Promise<Bar[]> {
  const { interval, barsPerDay } = TF_MAP[timeframe] ?? TF_MAP['1Day'];

  // Calendar-day lookback: add 2× buffer for weekends/holidays
  const calDays = Math.ceil((limit / barsPerDay) * 2) + 5;

  const period2 = new Date();
  const period1 = new Date(period2.getTime() - calDays * 24 * 60 * 60 * 1000);

  const result = await yf.chart(symbol, {
    period1: period1.toISOString().split('T')[0],
    period2: period2.toISOString().split('T')[0],
    interval,
  }, { validateResult: false }) as any;

  const quotes: any[] = result?.quotes ?? [];
  const bars = quotes
    .filter((q: any) => q.open != null && q.close != null)
    .map((q: any) => ({
      t: new Date(q.date).toISOString(),
      o: q.open,
      h: q.high,
      l: q.low,
      c: q.close,
      v: q.volume ?? 0,
    }))
    .slice(-limit);

  if (bars.length === 0) {
    throw new Error(`${symbol}: chart returned no usable bars (${interval})`);
  }
  return bars;
}
