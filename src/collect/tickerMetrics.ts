/**
 * The numbers behind the dashboard's stock page: where one ticker stands right now.
 *
 * Built for the operator, not the trader. Analyst ratings and price targets are shown here and
 * deliberately kept out of `Fundamentals` (see `get_fundamentals`' description): they are other
 * people's verdicts, which the operator may want to see but the trader should not lean on.
 *
 * The indicators are the ones the trader reads. When the last tick scored the symbol, its row is
 * used as-is so the page and the trader agree; otherwise they are computed here from the same
 * number of daily bars the tick uses.
 */

import type { Bar } from '../core/types';
import type { Policy } from '../policy/types';
import { computeSignals, signalTally, type SignalScore } from '../strategy/signals';
import { computeMeanReversionSignals } from '../strategy/meanReversion';
import { reversalFilter, type ReversalFilter } from '../strategy/reversal';
import { adx, atr, ema, macd, rsi } from '../strategy/indicators';
import type { WatchlistData } from '../features/compute';
import type { Fundamentals } from './fundamentals';

/** Daily bars the tick scores on (`DEFAULT_COLLECT_REQUEST.barLimit`). */
export const TICK_BAR_COUNT = 60;
/** Trading sessions in a year, for the 52-week range and annualised volatility. */
const YEAR_BARS = 252;

export interface AnalystView {
  /** 1 = strong buy … 5 = strong sell, Yahoo's scale. */
  recommendationMean: number | null;
  recommendationKey: string | null;
  analystCount: number | null;
  targetLow: number | null;
  targetMean: number | null;
  targetMedian: number | null;
  targetHigh: number | null;
  /** Latest month's rating counts. */
  ratings: { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number } | null;
  valuation: {
    trailingPE: number | null;
    forwardPE: number | null;
    pegRatio: number | null;
    priceToBook: number | null;
    priceToSales: number | null;
    /** Percent. */
    dividendYieldPct: number | null;
  };
}

export interface TickerMetrics {
  symbol: string;
  price: number | null;
  /** Where `price` came from: the last tick's quote, or the latest daily close. */
  priceSource: 'tick' | 'close' | null;
  priceStale: boolean;
  dayChangePct: number | null;
  range52w: {
    high: number | null;
    low: number | null;
    /** 0 = at the low, 100 = at the high. */
    positionPct: number | null;
    fromHighPct: number | null;
    fromLowPct: number | null;
    /** Sessions the range covers; under 252 means the history is shorter than a year. */
    sessions: number;
    source: 'bars' | 'yahoo' | null;
  };
  returns: Record<'1W' | '1M' | '3M' | '6M' | 'YTD' | '1Y', number | null>;
  movingAverages: {
    sma50: number | null;
    sma200: number | null;
    vsSma50Pct: number | null;
    vsSma200Pct: number | null;
    emaFast: number | null;
    emaSlow: number | null;
    emaFastPeriod: number;
    emaSlowPeriod: number;
  };
  momentum: {
    rsi: number | null;
    rsiPeriod: number;
    rsiEntryMin: number;
    rsiExitMax: number;
    macdHistogram: number | null;
    adx: number | null;
    atr: number | null;
    atrPct: number | null;
    /** Annualised, from daily returns over the last year. Percent. */
    volatilityPct: number | null;
    /** Last completed session's volume over its 20-session average. */
    relativeVolume: number | null;
  };
  trend: { composite: number | null; compositeMin: number; signals: SignalScore[] };
  meanReversion: { composite: number | null; signals: SignalScore[] };
  reversal: ReversalFilter | null;
  /** `tick` = the trader's own last reading; `bars` = computed here. */
  indicatorSource: 'tick' | 'bars' | null;
  fundamentals: Fundamentals | null;
  analysts: AnalystView | null;
  barsAsOf: string | null;
  errors: string[];
}

const round = (n: number | null, dp = 2): number | null => n == null || !Number.isFinite(n) ? null : parseFloat(n.toFixed(dp));
const pctChange = (to: number, from: number | undefined): number | null => from && from > 0 ? round((to / from - 1) * 100) : null;
const lastOf = (series: number[]): number | null => series.length ? series[series.length - 1] : null;
const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;

/**
 * PURE. Everything numeric on the page, from a daily series and what the caller already holds.
 * `bars` are completed daily sessions, oldest first.
 */
export function tickerMetrics(input: {
  symbol: string;
  bars: Bar[];
  policy: Policy;
  row?: WatchlistData | null;
  quote?: { price: number; stale: boolean } | null;
  fundamentals?: Fundamentals | null;
  analysts?: AnalystView | null;
  now?: Date;
}): TickerMetrics {
  const { symbol, bars, policy, row = null, fundamentals = null, analysts = null } = input;
  const s = policy.strategy, now = input.now ?? new Date();
  const closes = bars.map(b => b.c);
  const lastClose = lastOf(closes);
  const quote = input.quote ?? (row?.price != null ? { price: row.price, stale: row.stale } : null);
  const price = quote?.price ?? lastClose;

  const year = bars.slice(-YEAR_BARS);
  let high: number | null = null, low: number | null = null, rangeSource: 'bars' | 'yahoo' | null = null;
  if (year.length >= 2) {
    high = Math.max(...year.map(b => b.h)); low = Math.min(...year.map(b => b.l)); rangeSource = 'bars';
  } else if (fundamentals?.liquidity.fiftyTwoWeekHigh != null && fundamentals.liquidity.fiftyTwoWeekLow != null) {
    high = fundamentals.liquidity.fiftyTwoWeekHigh; low = fundamentals.liquidity.fiftyTwoWeekLow; rangeSource = 'yahoo';
  }
  // Today's quote can sit outside the range of completed sessions.
  if (price != null && high != null && low != null) { high = Math.max(high, price); low = Math.min(low, price); }
  const span = high != null && low != null ? high - low : null;

  const back = (n: number) => price == null || closes.length <= n ? null : pctChange(price, closes[closes.length - 1 - n]);
  const yearStart = `${now.getUTCFullYear()}-01-01`;
  const lastBeforeYear = [...bars].reverse().find(b => b.t.slice(0, 10) < yearStart);

  const sma = (n: number) => closes.length >= n ? mean(closes.slice(-n)) : null;
  const sma50 = sma(50), sma200 = sma(200);
  const vs = (level: number | null) => price == null || level == null ? null : pctChange(price, level);

  // The tick's own window, so a symbol it never scored reads like one it did.
  const window = bars.slice(-TICK_BAR_COUNT), windowCloses = window.map(b => b.c);
  const scored = window.length >= s.minBars;
  const trendSignals = row?.signals.length ? row.signals : scored ? computeSignals(window, policy) : [];
  const mrSignals = row?.meanReversionSignals.length ? row.meanReversionSignals : scored ? computeMeanReversionSignals(window, policy) : [];
  const fromTick = !!row?.signals.length;
  const rsiNow = fromTick ? row!.rsi : scored ? lastOf(rsi(windowCloses, s.rsiPeriod)) : null;
  const atrNow = fromTick ? row!.atr : scored ? lastOf(atr(window, s.atrPeriod)) : null;
  const macdNow = macd(windowCloses);

  const returns = closes.slice(-YEAR_BARS - 1).map((c, i, a) => i ? c / a[i - 1] - 1 : NaN).slice(1);
  const avgReturn = returns.length ? mean(returns) : 0;
  const volatility = returns.length >= 20 ? Math.sqrt(returns.reduce((t, r) => t + (r - avgReturn) ** 2, 0) / (returns.length - 1)) * Math.sqrt(YEAR_BARS) * 100 : null;
  const volumes = bars.slice(-21).map(b => b.v);
  const priorVolume = volumes.length === 21 ? mean(volumes.slice(0, 20)) : null;

  return {
    symbol,
    price: round(price),
    priceSource: quote ? 'tick' : lastClose != null ? 'close' : null,
    priceStale: quote?.stale ?? false,
    dayChangePct: row?.dayChangePct != null ? round(row.dayChangePct) : price != null && closes.length >= 2 ? pctChange(price, quote ? closes.at(-1) : closes.at(-2)) : null,
    range52w: {
      high: round(high), low: round(low),
      positionPct: price != null && span != null && span > 0 ? round((price - low!) / span * 100, 1) : null,
      fromHighPct: price != null && high ? pctChange(price, high) : null,
      fromLowPct: price != null && low ? pctChange(price, low) : null,
      sessions: rangeSource === 'bars' ? year.length : 0,
      source: rangeSource,
    },
    returns: { '1W': back(5), '1M': back(21), '3M': back(63), '6M': back(126), YTD: price != null && lastBeforeYear ? pctChange(price, lastBeforeYear.c) : null, '1Y': back(252) },
    movingAverages: {
      sma50: round(sma50), sma200: round(sma200), vsSma50Pct: vs(sma50), vsSma200Pct: vs(sma200),
      emaFast: round(fromTick ? row!.emaFast : scored ? lastOf(ema(windowCloses, s.emaFast)) : null),
      emaSlow: round(fromTick ? row!.emaSlow : scored ? lastOf(ema(windowCloses, s.emaSlow)) : null),
      emaFastPeriod: s.emaFast, emaSlowPeriod: s.emaSlow,
    },
    momentum: {
      rsi: round(rsiNow, 1), rsiPeriod: s.rsiPeriod, rsiEntryMin: s.rsiEntryMin, rsiExitMax: s.rsiExitMax,
      macdHistogram: round(macdNow ? lastOf(macdNow.histogram) : null, 3),
      adx: round(window.length >= 30 ? lastOf(adx(window)) : null, 1),
      atr: round(atrNow), atrPct: atrNow != null && price ? round(atrNow / price * 100) : null,
      volatilityPct: round(volatility, 1),
      relativeVolume: priorVolume ? round(volumes[20] / priorVolume) : null,
    },
    trend: { composite: trendSignals.length ? signalTally(trendSignals).composite : null, compositeMin: s.compositeMin, signals: trendSignals },
    meanReversion: { composite: mrSignals.length ? signalTally(mrSignals).composite : null, signals: mrSignals },
    reversal: row?.reversal ?? (window.length ? reversalFilter(window, fundamentals?.liquidity.marketCap ?? null) : null),
    indicatorSource: fromTick ? 'tick' : scored ? 'bars' : null,
    fundamentals,
    analysts,
    barsAsOf: bars.at(-1)?.t ?? null,
    errors: [],
  };
}

const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : v && typeof v === 'object' && 'raw' in (v as any) ? num((v as any).raw) : null;
const count = (v: unknown): number => num(v) ?? 0;

/** PURE. Yahoo's `financialData` + `recommendationTrend` + valuation fields, mapped. */
export function mapAnalystView(raw: any): AnalystView {
  const fd = raw?.financialData ?? {}, sd = raw?.summaryDetail ?? {}, ks = raw?.defaultKeyStatistics ?? {};
  const latest = (raw?.recommendationTrend?.trend ?? []).find((t: any) => t?.period === '0m') ?? null;
  const yieldFraction = num(sd.dividendYield) ?? num(sd.trailingAnnualDividendYield);
  return {
    recommendationMean: round(num(fd.recommendationMean)),
    recommendationKey: typeof fd.recommendationKey === 'string' && fd.recommendationKey !== 'none' ? fd.recommendationKey : null,
    analystCount: num(fd.numberOfAnalystOpinions),
    targetLow: round(num(fd.targetLowPrice)), targetMean: round(num(fd.targetMeanPrice)),
    targetMedian: round(num(fd.targetMedianPrice)), targetHigh: round(num(fd.targetHighPrice)),
    ratings: latest ? { strongBuy: count(latest.strongBuy), buy: count(latest.buy), hold: count(latest.hold), sell: count(latest.sell), strongSell: count(latest.strongSell) } : null,
    valuation: {
      trailingPE: round(num(sd.trailingPE)), forwardPE: round(num(sd.forwardPE) ?? num(ks.forwardPE)),
      pegRatio: round(num(ks.pegRatio)), priceToBook: round(num(ks.priceToBook)),
      priceToSales: round(num(sd.priceToSalesTrailing12Months)),
      dividendYieldPct: yieldFraction == null ? null : round(yieldFraction * 100),
    },
  };
}
