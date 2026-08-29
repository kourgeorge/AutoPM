/**
 * The scoreboard: did this beat holding SPY, and was the volatility worth it.
 *
 * `metrics.ts` answers "how did the trades behave" — win rate, expectancy, drawdown of the
 * realised P&L. Every one of those is an ABSOLUTE trade-shape statistic, and a set of
 * absolute statistics cannot answer the only question that decides whether running this
 * system is worth doing: nine wins out of eleven is a bad month if SPY rose more in the same
 * fortnight while sitting still. That question needs a denominator and a benchmark, and this
 * file is where both live.
 *
 * WHY THIS IS NOT A FIELD ON `Scorecard`. The scorecard sums REALISED round trips. Open
 * positions contribute nothing to it, and it has no capital base — a $400 gross profit is
 * not a return until something says "of what". Setting that sum beside SPY's percentage
 * would compare a dollar figure over closed trades to a percentage over continuous
 * exposure, which is not a comparison at all. The honest pairing is equity curve against
 * index over the same sessions, so that is what this computes, from a different source (the
 * broker's own portfolio history) and on a different unit (percentage points of equity).
 *
 * Same division of labour as everywhere else in `review/`: this measures, and the model
 * interprets. There is no verdict field, no "underperforming", no grade. `caveats` are facts
 * about the DATA and about the method — a window too short to mean anything, a deposit
 * sitting inside the equity curve — never advice about what to do next.
 */

import { config } from '../core/config';
import { alpacaTrading } from '../core/alpacaHttp';
import { logger } from '../core/logger';
import { collectBars } from '../collect/barSource';
import { isPresent } from '../collect/types';

/** Sessions per year, for annualising a daily Sharpe. The market's own constant. */
const TRADING_DAYS_PER_YEAR = 252;

/** Below this the ratio is dominated by the sample, not by the strategy. Still reported. */
const THIN_SESSIONS = 30;

/** Fewer daily returns than this and a standard deviation is not worth printing at all. */
const MIN_RETURNS_FOR_SHARPE = 5;

export interface Benchmark {
  /**
   * The window ACTUALLY compared, after aligning the two series by date: `sessions` is the
   * number of dates present in both, which is what every figure below is computed over. It
   * can be well short of `days` — a new account, a holiday week, or a broker that only kept
   * part of the history.
   */
  window: { from: string | null; to: string | null; days: number; sessions: number };

  /** Equity curve, first aligned session to last, percentage points. */
  portfolioReturnPct: number | null;
  /** SPY close to close over the same aligned dates, percentage points. */
  spyReturnPct: number | null;
  /**
   * portfolio − SPY, percentage points. The one number this file exists to produce: positive
   * means the trading added something that holding the index would not have.
   */
  excessPct: number | null;

  /**
   * Annualised mean daily return over its standard deviation, from the equity curve.
   *
   * Risk-free rate is ZERO, deliberately and not for want of a source: the comparison that
   * matters here is against doing nothing at all, and a noisy estimate of cash yield only
   * moves the bar in a way nobody can audit. So read this as return per unit of volatility,
   * not as excess over cash — the `spySharpe` beside it is the reference point, computed the
   * identical way over the identical sessions.
   */
  portfolioSharpe: number | null;
  spySharpe: number | null;
  /** Annualised standard deviation of the equity curve's daily returns, percentage points. */
  portfolioVolPct: number | null;
  spyVolPct: number | null;

  /**
   * Deepest peak-to-trough decline of the EQUITY CURVE, percentage points, ≥ 0.
   *
   * NOT the same statistic as `Scorecard.maxDrawdown`, which is a running sum over realised
   * round-trip P&L in dollars and cannot see the mark-to-market path of an open position.
   * These two will disagree and both will be right. Do not unify them.
   */
  maxDrawdownPct: number | null;
  spyMaxDrawdownPct: number | null;

  caveats: string[];
}

// ── Series plumbing ─────────────────────────────────────────────────────────────

/**
 * A date in exchange time.
 *
 * Both series are aligned on this string and the timezone is the whole point: portfolio
 * equity is stamped at the session's ET close and a daily bar at its ET open, so reading
 * either in UTC rolls some of them onto the neighbouring date and the two series then join
 * one day out of step. Built from `formatToParts` rather than a locale string so the format
 * is ours and not the runtime's.
 */
const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function etDate(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const parts = ET_PARTS.formatToParts(new Date(ms));
  const get = (type: string) => parts.find(p => p.type === type)?.value;
  const [y, m, d] = [get('year'), get('month'), get('day')];
  return y && m && d ? `${y}-${m}-${d}` : null;
}

/**
 * Simple (not log) daily returns, as fractions.
 *
 * `portfolioRisk.ts` has a module-private `dailyReturns` that returns LOG returns, and these
 * two must not be merged: log returns are the right input to a correlation (symmetric, and
 * additive over time), simple returns are the right input to a total return and to a Sharpe
 * (they are what the account actually earned). Same name, different quantity, on purpose.
 */
function dailyReturns(levels: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < levels.length; i++) {
    if (levels[i - 1] > 0) out.push(levels[i] / levels[i - 1] - 1);
  }
  return out;
}

/** Sample standard deviation, n−1. Null below two points, where dispersion is undefined. */
function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/** Annualised mean-over-sigma. Null when sigma is zero — a flat line has no ratio. */
function annualisedSharpe(returns: number[]): number | null {
  if (returns.length < MIN_RETURNS_FOR_SHARPE) return null;
  const sd = stdev(returns);
  if (sd == null || sd === 0) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  return (mean / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

function annualisedVolPct(returns: number[]): number | null {
  const sd = stdev(returns);
  return sd == null ? null : sd * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
}

/** Peak-to-trough of a level series, percentage points, ≥ 0. */
function maxDrawdownPct(levels: number[]): number | null {
  if (levels.length < 2) return null;
  let peak = levels[0];
  let worst = 0;
  for (const v of levels) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.max(worst, ((peak - v) / peak) * 100);
  }
  return worst;
}

function r(n: number | null, dp = 2): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ── The two legs ────────────────────────────────────────────────────────────────

interface Leg {
  /** ET date → level. Empty when the leg could not be fetched. */
  series: Map<string, number>;
  error: string | null;
}

/**
 * The account's own equity curve, one point per session.
 *
 * Alpaca-only by nature: `alpacaTrading` reaches the trading account only when that is the
 * active broker (see the note on `config.broker`), and IBKR has no equivalent endpoint we
 * hold. Under `BROKER=ibkr` this returns an error rather than a zero, because a benchmark
 * that silently reports 0 % for the portfolio leg would read as "flat" rather than "unknown"
 * and that is the one misreading this whole file is built to prevent.
 */
async function fetchEquityCurve(days: number): Promise<Leg> {
  if (config.broker !== 'alpaca') {
    return {
      series: new Map(),
      error: `portfolio history unavailable — BROKER is '${config.broker}' and the equity-curve endpoint belongs to Alpaca`,
    };
  }

  try {
    const res = await alpacaTrading.get('/v2/account/portfolio/history', {
      params: { period: `${days}D`, timeframe: '1D' },
    });

    const stamps: unknown[] = Array.isArray(res.data?.timestamp) ? res.data.timestamp : [];
    const equity: unknown[] = Array.isArray(res.data?.equity) ? res.data.equity : [];

    const series = new Map<string, number>();
    for (let i = 0; i < Math.min(stamps.length, equity.length); i++) {
      const value = Number(equity[i]);
      // Zero equity is what Alpaca reports for sessions before the account was funded. It is
      // not a $0 portfolio, and treating it as a level would manufacture a −100 % day.
      if (!Number.isFinite(value) || value <= 0) continue;
      const date = etDate(Number(stamps[i]) * 1000);
      if (date) series.set(date, value);
    }

    return {
      series,
      error: series.size === 0 ? 'portfolio history returned no usable equity points' : null,
    };
  } catch (err: any) {
    logger.warn(`[benchmark] portfolio history failed: ${err?.message ?? err}`);
    return { series: new Map(), error: `portfolio history unavailable — ${err?.message ?? err}` };
  }
}

/** SPY daily closes. Over-fetched on purpose: the intersection below does the trimming. */
async function fetchSpyCurve(days: number): Promise<Leg & { stale: boolean }> {
  const bars = await collectBars('SPY', days + 10, '1Day');
  if (!isPresent(bars)) {
    return { series: new Map(), error: `SPY bars unavailable — ${bars.error}`, stale: true };
  }

  const series = new Map<string, number>();
  for (const bar of bars.value) {
    const date = etDate(Date.parse(bar.t));
    if (date && Number.isFinite(bar.c) && bar.c > 0) series.set(date, bar.c);
  }

  return {
    series,
    error: series.size === 0 ? 'SPY bars carried no usable closes' : null,
    stale: bars.stale,
  };
}

/**
 * Did money enter or leave the account inside the window.
 *
 * The equity curve is NOT adjusted for this and never will be here — a deposit-adjusted
 * return needs a per-flow weighting that the daily series cannot support, and inventing one
 * would be exactly the "never guess a datum" failure. So the flow is DETECTED and STATED,
 * and the model is told the return figure includes it.
 *
 * `after` is re-checked locally because Alpaca filters activities on their CREATION time,
 * which is not the day the cash moved.
 */
async function cashFlowsInWindow(from: string): Promise<{ count: number | null }> {
  if (config.broker !== 'alpaca') return { count: null };

  try {
    const res = await alpacaTrading.get('/v2/account/activities', {
      params: { activity_types: 'CSD,CSW,JNLC', after: `${from}T00:00:00Z`, page_size: 100 },
    });
    const rows: any[] = Array.isArray(res.data) ? res.data : [];
    const inWindow = rows.filter((a) => {
      const stamp = String(a?.date ?? a?.transaction_time ?? '').slice(0, 10);
      return stamp !== '' && stamp >= from;
    });
    return { count: inWindow.length };
  } catch (err: any) {
    logger.warn(`[benchmark] activities lookup failed: ${err?.message ?? err}`);
    return { count: null };
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────────

/**
 * Compare the account's equity curve to SPY over the same sessions.
 *
 * `days` is a calendar lookback, not a session count; `window.sessions` reports what the
 * two series actually had in common. Either leg can be missing and the other is still
 * returned — half a comparison plus a caveat naming which half is absent beats a zero
 * standing in for a number nobody has.
 */
export async function benchmark(opts: { days?: number } = {}): Promise<Benchmark> {
  const days = opts.days ?? 30;
  const caveats: string[] = [];

  const [equityLeg, spyLeg] = await Promise.all([fetchEquityCurve(days), fetchSpyCurve(days)]);
  if (equityLeg.error) caveats.push(equityLeg.error);
  if (spyLeg.error) caveats.push(spyLeg.error);
  if (!spyLeg.error && spyLeg.stale) {
    caveats.push('the last SPY bar is stale, so the benchmark leg may end a session short of the portfolio leg');
  }

  // Aligned by DATE and never by index: around a holiday the two series differ in length,
  // and an index join would then silently compare a Tuesday to a Wednesday for the rest of
  // the window.
  const dates = [...equityLeg.series.keys()]
    .filter(d => spyLeg.series.has(d))
    .sort();

  // Each leg alone, for the case where only one arrived. Dates are the intersection when
  // both did, so the two return figures always cover the same sessions.
  const equityDates = dates.length > 0 ? dates : [...equityLeg.series.keys()].sort();
  const spyDates = dates.length > 0 ? dates : [...spyLeg.series.keys()].sort();

  const equityLevels = equityDates.map(d => equityLeg.series.get(d)!).filter(Number.isFinite);
  const spyLevels = spyDates.map(d => spyLeg.series.get(d)!).filter(Number.isFinite);

  const totalReturnPct = (levels: number[]): number | null =>
    levels.length >= 2 && levels[0] > 0 ? (levels[levels.length - 1] / levels[0] - 1) * 100 : null;

  const portfolioReturnPct = totalReturnPct(equityLevels);
  const spyReturnPct = totalReturnPct(spyLevels);

  const equityReturns = dailyReturns(equityLevels);
  const spyReturns = dailyReturns(spyLevels);

  const sessions = dates.length;
  const from = (dates[0] ?? equityDates[0] ?? spyDates[0]) ?? null;
  const to = (dates[dates.length - 1] ?? equityDates[equityDates.length - 1] ?? spyDates[spyDates.length - 1]) ?? null;

  if (equityLevels.length > 0 && spyLevels.length > 0 && sessions === 0) {
    caveats.push('the equity curve and the SPY series share no dates, so nothing here is a comparison — the two figures cover different sessions');
  }
  if (sessions > 0 && sessions < THIN_SESSIONS) {
    caveats.push(`window is ${sessions} session(s) — too short for a meaningful comparison, and one good or bad day moves every figure here`);
  }
  if (equityReturns.length > 0 && equityReturns.length < MIN_RETURNS_FOR_SHARPE) {
    caveats.push(`only ${equityReturns.length} daily return(s) — no standard deviation is reported below ${MIN_RETURNS_FOR_SHARPE}, so the Sharpe figures are null rather than noisy`);
  }

  if (from != null) {
    const flows = await cashFlowsInWindow(from);
    if (flows.count == null) {
      caveats.push('deposits and withdrawals in the window could not be checked; the equity curve is not adjusted for them in any case, so any cash movement shows up as return');
    } else if (flows.count > 0) {
      caveats.push(`${flows.count} cash movement(s) (deposit, withdrawal or journal) fall inside this window — the equity curve includes them, so portfolioReturnPct is NOT a pure return series and the excess figure is not attributable to trading`);
    }
  }

  if (equityReturns.length >= MIN_RETURNS_FOR_SHARPE) {
    caveats.push('Sharpe figures use a zero risk-free rate on both legs — read them as return per unit of volatility, and compare portfolio to SPY rather than to a textbook threshold');
  }

  return {
    window: { from, to, days, sessions },

    portfolioReturnPct: r(portfolioReturnPct),
    spyReturnPct: r(spyReturnPct),
    excessPct:
      portfolioReturnPct != null && spyReturnPct != null && sessions > 0
        ? r(portfolioReturnPct - spyReturnPct)
        : null,

    portfolioSharpe: r(annualisedSharpe(equityReturns)),
    spySharpe: r(annualisedSharpe(spyReturns)),
    portfolioVolPct: r(annualisedVolPct(equityReturns)),
    spyVolPct: r(annualisedVolPct(spyReturns)),

    maxDrawdownPct: r(maxDrawdownPct(equityLevels)),
    spyMaxDrawdownPct: r(maxDrawdownPct(spyLevels)),

    caveats,
  };
}
