import { Bar } from '../core/types';
import { isCryptoSymbol } from '../core/symbols';

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

/** The modules requested in one `quoteSummary` call. Absent ones are a fact, not an error. */
export const FUNDAMENTAL_MODULES = [
  'calendarEvents',
  'defaultKeyStatistics',
  'financialData',
  'summaryDetail',
  'earningsTrend',
  'earningsHistory',
] as const;

export interface RawFundamentals {
  /** The `quoteSummary` payload, unmapped. */
  raw: any;
  /**
   * Which of `FUNDAMENTAL_MODULES` came back as keys. Measured, because Yahoo omits a module
   * ENTIRELY rather than nulling its fields: XLE returns only `summaryDetail` and
   * `defaultKeyStatistics` (measured 2026-08-26). "No `calendarEvents` for XLE" is a durable
   * fact about the symbol and worth caching; a thrown call is not.
   */
  modulesPresent: string[];
}

/**
 * Fetch fundamentals, THROWING on failure — like `getQuoteRaw` and `getBarsRaw`, and unlike
 * `getSectorRaw`. The caller caches, and a cache that cannot tell a failed call from a
 * genuinely empty answer would freeze a network blip into a permanent "unknown".
 *
 * Crypto is rejected before the call rather than mangled by it. A coin has no earnings date and
 * no balance sheet, so there is nothing here to fetch for one; and the three spellings in play
 * (`BTC/USD` as this system writes it, `BTCUSD` as Alpaca reports it, `BTC-USD` as Yahoo wants
 * it) mean a `quoteSummary` on whichever one the caller holds returns nothing or something
 * unrelated.
 *
 * The test itself lives in `core/symbols.ts` as `isCryptoSymbol`, alongside `canonicalSymbol`:
 * the brokers pick a time-in-force with it and the venue stop path decides whether a stop can
 * exist at all with it, and two copies of that regex would eventually be two answers.
 */
export async function getFundamentalsRaw(symbol: string): Promise<RawFundamentals> {
  if (isCryptoSymbol(symbol)) {
    throw new Error(`${symbol}: fundamentals are equities-only — no earnings or balance sheet exists for a crypto pair`);
  }

  // validateResult:false, third positional — mandatory, for the reason in `getQuoteRaw`.
  // `earningsTrend` drifts per symbol as much as `assetProfile` does.
  const raw = await yf.quoteSummary(
    symbol,
    { modules: [...FUNDAMENTAL_MODULES] },
    { validateResult: false },
  ) as any;

  if (raw == null || typeof raw !== 'object') {
    throw new Error(`${symbol}: quoteSummary returned no object`);
  }

  const modulesPresent = FUNDAMENTAL_MODULES.filter(m => m in raw && raw[m] != null);
  return { raw, modulesPresent };
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
/**
 * NOT HERE: the high and low actually traded over a window. It was written here first and moved
 * to `priceSource.ts` (`fetchTradedRange`) after measuring what this vendor serves intraday.
 * Yahoo's `5m` series carries bars with `volume: 0` — CRM showed a 236.00 high in a bar where
 * nothing traded, 14% above the regular session — so the one source used to decide whether a
 * price is real was itself inventing prices. Alpaca's bars carry a trade count per bar.
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
