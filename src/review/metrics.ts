/**
 * The scorecard: arithmetic over round trips, and nothing else.
 *
 * Every number here is computed in code and none is computed by the model. That split is
 * the whole reason this file exists rather than a prompt asking the trader to "review your
 * recent performance" — asked to count its own wins from a journal, a language model
 * produces a plausible win rate, and a plausible win rate is indistinguishable from a real
 * one until it is used to size a position.
 *
 * Correspondingly there are NO verdicts here. No grade, no "performing well", no
 * recommendation. Interpretation is the reasoning module's job and this is its instrument;
 * a metric that arrives pre-judged has spent the model's independence before it reads it.
 *
 * `caveats` is the one exception, and it is not a judgement: each entry is a fact about the
 * DATA rather than about the trading — nine trades is nine trades, and a sample that cannot
 * support a conclusion should say so next to the number rather than three paragraphs later.
 */

import { getPolicy } from '../policy/load';
import { computeOutcomes, type TradeOutcome } from './ledger';

/**
 * Where a mean-over-sigma stops being a measurement.
 *
 * Same threshold as the win-rate caveat further down, and for the same reason — but stated
 * separately because a ratio degrades faster than a mean does: the sample estimates both the
 * numerator and the denominator, so its error compounds.
 */
const perTradeSharpeIsThin = (trades: number) => trades < 20;

/** Round for transport. A win rate is not more true at fifteen decimal places. */
function r(n: number | null, dp = 2): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function mean(xs: number[]): number | null {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Sample standard deviation, n−1. Null below two points, where dispersion is not defined.
 *
 * n−1 rather than n because these trades are a SAMPLE of how the strategy behaves and not
 * the population of every trade it will ever take. The difference is invisible at a hundred
 * trades and is a tenth of the answer at ten, which is the range this file actually runs in.
 */
function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Mean over sigma, guarding the flat-line case where sigma is zero and the ratio is not. */
function meanOverSigma(xs: number[]): number | null {
  const sd = stdev(xs);
  if (sd == null || sd === 0) return null;
  return (xs.reduce((a, b) => a + b, 0) / xs.length) / sd;
}

export interface GroupStats {
  trades: number;
  grossPnL: number;
  winRate: number | null;
  /** Mean gross P&L per trade, in dollars. */
  expectancy: number | null;
}

export interface Scorecard {
  /**
   * Coverage of the DATA, not of the request: `from` is the earliest entry and `to` the
   * latest exit among the round trips counted. `days` echoes the requested lookback, which
   * is applied to EXIT time — so `from` routinely predates it.
   */
  window: { from: string | null; to: string | null; days: number | null };

  /** Completed round trips only. Open positions contribute nothing. */
  trades: number;
  wins: number;
  losses: number;
  /** Exactly flat. Counted apart so they cannot flatter the win rate either way. */
  scratches: number;
  winRate: number | null;

  grossPnL: number;
  /** False when any fill in the window did not report its fee, which is the Alpaca case. */
  feesComplete: boolean;
  fees: number | null;
  /** Null unless every fill reported a fee. `grossPnL` is the comparable number when it is. */
  netPnL: number | null;

  avgWin: number | null;
  /** Negative, by construction. */
  avgLoss: number | null;
  /** Sum of wins over the absolute sum of losses. Null with no losses — not Infinity. */
  profitFactor: number | null;
  /** Mean gross P&L per trade, in dollars. The number position sizing actually depends on. */
  expectancy: number | null;
  /** Mean return per trade, in percent. Comparable across position sizes. */
  expectancyPct: number | null;
  /**
   * Mean outcome in units of the risk the entry declared — gross P&L over
   * `(entry - intendedStop) x qty`.
   *
   * The most informative single figure for a stopped strategy, because it is the only one
   * that is not distorted by position size or by how wide the stops were: +0.3R means each
   * trade returned three tenths of what it was willing to lose. Computed only over round
   * trips whose entry has a journal record, so `expectancyRSample` may be well below `trades`.
   */
  expectancyR: number | null;
  expectancyRSample: number;

  // ── Dispersion: the half an expectancy on its own leaves out ────────────────
  //
  // Every figure above is a mean, and a mean is half of an outcome. +0.4R average over
  // trades that ranged −3R to +5R is a different strategy from +0.4R over trades that all
  // landed between 0 and +1R, and position sizing that cannot tell them apart is sizing on
  // one number where two are needed.

  /** Standard deviation of the per-trade return, in percent. */
  returnPctStdev: number | null;
  /**
   * Mean per-trade return over its standard deviation.
   *
   * NOT the Sharpe ratio, and must not be quoted as one or compared to the thresholds people
   * carry for it: there is no time in this figure. It is dispersion per trade, so a strategy
   * that takes this trade weekly and one that takes it hourly score identically, and no
   * amount of it says anything about what the capital did while it was idle. `get_benchmark`
   * holds the time-weighted, benchmark-relative version, computed off the equity curve.
   */
  perTradeSharpe: number | null;
  /** The same ratio in units of declared risk: mean R over the standard deviation of R. */
  perTradeSharpeR: number | null;
  /**
   * How many standard errors the mean return sits above ZERO — `mean / (sd / √n)`.
   *
   * Zero is the benchmark on purpose, rather than the sample's own historical mean: a noisy
   * mean is an artificially low bar, and "did better than its own average" is a statement
   * about the sample rather than about the strategy. So this answers one question only — is
   * the edge distinguishable from no edge at all, at this sample size. Roughly ±2 is the
   * conventional line, and it is a property of the DATA, not a verdict on the trading.
   */
  expectancyTStat: number | null;

  best: TradeSummary | null;
  worst: TradeSummary | null;

  avgHoldHours: number | null;
  medianHoldHours: number | null;
  /**
   * Hold time split by outcome. A winners-shorter-than-losers gap is the classic
   * cut-flowers-water-weeds signature; stated as two numbers, not as that conclusion.
   */
  avgHoldWinnersHours: number | null;
  avgHoldLosersHours: number | null;

  /** Deepest peak-to-trough decline of the cumulative REALISED gross P&L, in dollars. */
  maxDrawdown: number;
  maxConsecutiveLosses: number;

  stopDiscipline: {
    /** Round trips whose entry recorded an intended stop. The rest cannot be assessed. */
    measurable: number;
    /**
     * Exits that landed below the declared stop — the declared risk was exceeded, whether
     * by a gap, a detector that did not fire, or a decision not to act on one.
     */
    breached: number;
    /** How far past the stop the worst of those exited, in percent of the stop. */
    worstBreachPct: number | null;
    /** Mean distance from entry to stop, in percent. */
    avgStopDistancePct: number | null;
    /**
     * Mean stop distance in ATRs, against `policy.risk.stopLossAtrMult`. A gap between them
     * means the stops being placed are not the stops the policy describes.
     */
    avgStopAtrMultiple: number | null;
    policyStopAtrMult: number;
  };

  bySymbol: Record<string, GroupStats>;
  /** Whether a policy change moved the numbers. Null-keyed as "unknown" for old records. */
  byPolicyVersion: Record<string, GroupStats>;

  /**
   * Facts about the data that limit what any of the above can support. Not advice.
   */
  caveats: string[];
}

export interface TradeSummary {
  symbol: string;
  exitAt: string;
  grossPnL: number;
  returnPct: number;
  holdHours: number;
  entryRationale: string | null;
}

function summarise(o: TradeOutcome): TradeSummary {
  return {
    symbol: o.symbol,
    exitAt: o.exitAt,
    grossPnL: r(o.grossPnL)!,
    returnPct: r(o.returnPct)!,
    holdHours: r(o.holdingMs / 3_600_000)!,
    entryRationale: o.entryRationale,
  };
}

function groupBy(
  outcomes: TradeOutcome[],
  key: (o: TradeOutcome) => string,
): Record<string, GroupStats> {
  const buckets = new Map<string, TradeOutcome[]>();
  for (const o of outcomes) {
    const k = key(o);
    const list = buckets.get(k);
    if (list) list.push(o);
    else buckets.set(k, [o]);
  }

  const out: Record<string, GroupStats> = {};
  for (const [k, list] of [...buckets].sort((a, b) => b[1].length - a[1].length)) {
    const gross = list.reduce((a, o) => a + o.grossPnL, 0);
    out[k] = {
      trades: list.length,
      grossPnL: r(gross)!,
      winRate: r((list.filter(o => o.grossPnL > 0).length / list.length) * 100),
      expectancy: r(gross / list.length),
    };
  }
  return out;
}

/**
 * Aggregate the completed round trips in a window.
 *
 * `days` is a lookback on EXIT time, because a round trip is only measurable once it is
 * closed and that is when it enters the record. A trade entered before the window and
 * exited inside it belongs to the window; the alternative silently drops long holds.
 */
export function scorecard(opts: { symbol?: string; days?: number } = {}): Scorecard {
  const since = opts.days != null ? new Date(Date.now() - opts.days * 86_400_000) : undefined;
  const outcomes = computeOutcomes({ symbol: opts.symbol, since });
  const policyStopAtrMult = getPolicy().risk.stopLossAtrMult;

  const empty: Scorecard = {
    window: { from: null, to: null, days: opts.days ?? null },
    trades: 0, wins: 0, losses: 0, scratches: 0, winRate: null,
    grossPnL: 0, feesComplete: false, fees: null, netPnL: null,
    avgWin: null, avgLoss: null, profitFactor: null,
    expectancy: null, expectancyPct: null, expectancyR: null, expectancyRSample: 0,
    returnPctStdev: null, perTradeSharpe: null, perTradeSharpeR: null, expectancyTStat: null,
    best: null, worst: null,
    avgHoldHours: null, medianHoldHours: null,
    avgHoldWinnersHours: null, avgHoldLosersHours: null,
    maxDrawdown: 0, maxConsecutiveLosses: 0,
    stopDiscipline: {
      measurable: 0, breached: 0, worstBreachPct: null,
      avgStopDistancePct: null, avgStopAtrMultiple: null, policyStopAtrMult,
    },
    bySymbol: {}, byPolicyVersion: {},
    caveats: [
      'No completed round trips in this window — nothing here is measurable yet.',
      'get_benchmark still works with an empty ledger: it reads the equity curve, so it can say what the account did even when no round trip has closed.',
    ],
  };
  if (outcomes.length === 0) return empty;

  const wins = outcomes.filter(o => o.grossPnL > 0);
  const losses = outcomes.filter(o => o.grossPnL < 0);
  const scratches = outcomes.length - wins.length - losses.length;

  const grossPnL = outcomes.reduce((a, o) => a + o.grossPnL, 0);
  const sumWins = wins.reduce((a, o) => a + o.grossPnL, 0);
  const sumLosses = losses.reduce((a, o) => a + o.grossPnL, 0);

  const feesComplete = outcomes.every(o => o.feesComplete);
  const reportedFees = outcomes.reduce((a, o) => a + (o.fees ?? 0), 0);

  // Realised equity curve, in order of exit. Drawdown on realised P&L only: the
  // mark-to-market path of an open position is not in the ledger, so a deeper intra-trade
  // trough is invisible here and this figure is a floor, not the true worst.
  let peak = 0, running = 0, maxDrawdown = 0;
  let streak = 0, maxConsecutiveLosses = 0;
  for (const o of outcomes) {
    running += o.grossPnL;
    peak = Math.max(peak, running);
    maxDrawdown = Math.max(maxDrawdown, peak - running);
    streak = o.grossPnL < 0 ? streak + 1 : 0;
    maxConsecutiveLosses = Math.max(maxConsecutiveLosses, streak);
  }

  const holds = outcomes.map(o => o.holdingMs / 3_600_000);

  // R multiples, over the subset whose entry declared a stop.
  const rMultiples: number[] = [];
  const stopDistances: number[] = [];
  const stopAtrMultiples: number[] = [];
  let breached = 0;
  let worstBreachPct: number | null = null;

  for (const o of outcomes) {
    const stop = o.intendedStop;
    if (stop == null || !(stop > 0) || !(o.entryPrice > stop)) continue;

    const riskPerShare = o.entryPrice - stop;
    rMultiples.push(o.grossPnL / (riskPerShare * o.qty));
    stopDistances.push((riskPerShare / o.entryPrice) * 100);
    if (o.atrAtEntry != null && o.atrAtEntry > 0) {
      stopAtrMultiples.push(riskPerShare / o.atrAtEntry);
    }

    if (o.exitPrice < stop) {
      breached++;
      const slip = ((stop - o.exitPrice) / stop) * 100;
      worstBreachPct = worstBreachPct == null ? slip : Math.max(worstBreachPct, slip);
    }
  }

  const returnPcts = outcomes.map(o => o.returnPct);
  const returnPctStdev = stdev(returnPcts);

  const withoutRationale = outcomes.filter(o => o.entryRationale == null).length;
  const unexplained = outcomes.filter(o => o.unexplained).length;

  const caveats: string[] = [];
  if (outcomes.length < 20) {
    caveats.push(`${outcomes.length} completed round trip(s) — too few for the win rate or expectancy to distinguish skill from variance.`);
  }
  if (!feesComplete) {
    caveats.push('Not every fill reported its fee, so netPnL is null and every figure above is GROSS. Compare gross to gross.');
  }
  if (withoutRationale > 0) {
    caveats.push(`${withoutRationale} of ${outcomes.length} round trip(s) have no journal record for the entry, so no rationale, stop or policy version — they count in the P&L and cannot be reasoned about.`);
  }
  if (rMultiples.length < outcomes.length) {
    caveats.push(`expectancyR covers ${rMultiples.length} of ${outcomes.length} round trip(s); the rest declared no usable stop.`);
  }
  if (unexplained > 0) {
    caveats.push(`${unexplained} round trip(s) had fills that do not add up (a sell larger than the recorded position) — their numbers are a best reading, not a reconciliation.`);
  }

  // Stated on EVERY call, because the absence of a benchmark is a permanent property of this
  // file rather than a shortfall of a particular window. Nothing above answers "was this
  // better than sitting in SPY", and a page of win rates reads as though something did.
  caveats.push('Nothing here is vol-adjusted over time and nothing here is compared to a benchmark: these are trade-shape statistics, so a good page of them is still compatible with having lost to holding SPY. get_benchmark has the equity curve against SPY, with Sharpe for both.');

  if (returnPctStdev != null && perTradeSharpeIsThin(outcomes.length)) {
    caveats.push(`perTradeSharpe and expectancyTStat are computed over ${outcomes.length} round trip(s) — at this sample size the standard deviation is itself an estimate, so treat both as an order of magnitude and not as a measurement.`);
  }
  if (returnPctStdev === 0) {
    caveats.push('every round trip returned exactly the same percentage, so the dispersion figures are null rather than infinite — check the fills before reading anything into that.');
  }

  // The extremes of the DATA, taken as extremes rather than as the ends of the array:
  // `outcomes` is ordered by EXIT, so `outcomes[0].entryAt` was the entry of the
  // earliest-EXITING trade — a long hold opened months earlier and closed last reported a
  // `from` after trades that came before it, which is a window that excludes its own contents.
  const earliest = (a: string, b: string) => (Date.parse(a) <= Date.parse(b) ? a : b);
  const latest = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);

  return {
    window: {
      from: outcomes.reduce((acc, o) => earliest(acc, o.entryAt), outcomes[0].entryAt),
      to: outcomes.reduce((acc, o) => latest(acc, o.exitAt), outcomes[0].exitAt),
      days: opts.days ?? null,
    },
    trades: outcomes.length,
    wins: wins.length,
    losses: losses.length,
    scratches,
    winRate: r((wins.length / outcomes.length) * 100),

    grossPnL: r(grossPnL)!,
    feesComplete,
    fees: feesComplete || reportedFees > 0 ? r(reportedFees) : null,
    netPnL: feesComplete ? r(grossPnL - reportedFees) : null,

    avgWin: r(mean(wins.map(o => o.grossPnL))),
    avgLoss: r(mean(losses.map(o => o.grossPnL))),
    // No losses is not an infinite profit factor, it is an unmeasurable one.
    profitFactor: sumLosses < 0 ? r(sumWins / Math.abs(sumLosses)) : null,
    expectancy: r(grossPnL / outcomes.length),
    expectancyPct: r(mean(outcomes.map(o => o.returnPct))),
    expectancyR: r(mean(rMultiples)),
    expectancyRSample: rMultiples.length,

    returnPctStdev: r(returnPctStdev),
    // Three decimals: these are ratios near 1, where two decimals throws away a tenth of
    // the resolution, unlike a win rate where it throws away nothing anybody can act on.
    perTradeSharpe: r(meanOverSigma(returnPcts), 3),
    perTradeSharpeR: r(meanOverSigma(rMultiples), 3),
    expectancyTStat: r(
      returnPctStdev != null && returnPctStdev > 0
        ? mean(returnPcts)! / (returnPctStdev / Math.sqrt(returnPcts.length))
        : null,
      2,
    ),

    best: summarise(outcomes.reduce((a, b) => (b.returnPct > a.returnPct ? b : a))),
    worst: summarise(outcomes.reduce((a, b) => (b.returnPct < a.returnPct ? b : a))),

    avgHoldHours: r(mean(holds)),
    medianHoldHours: r(median(holds)),
    avgHoldWinnersHours: r(mean(wins.map(o => o.holdingMs / 3_600_000))),
    avgHoldLosersHours: r(mean(losses.map(o => o.holdingMs / 3_600_000))),

    maxDrawdown: r(maxDrawdown)!,
    maxConsecutiveLosses,

    stopDiscipline: {
      measurable: rMultiples.length,
      breached,
      worstBreachPct: r(worstBreachPct),
      avgStopDistancePct: r(mean(stopDistances)),
      avgStopAtrMultiple: r(mean(stopAtrMultiples)),
      policyStopAtrMult,
    },

    bySymbol: groupBy(outcomes, o => o.symbol),
    byPolicyVersion: groupBy(outcomes, o => (o.policyVersion != null ? `v${o.policyVersion}` : 'unknown')),

    caveats,
  };
}
