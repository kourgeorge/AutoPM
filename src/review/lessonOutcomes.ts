/**
 * Did a lesson help? For each lesson, the closed round trips whose entry was made with it in
 * the cycle context, next to those made without it — and the ones whose reason cited it.
 *
 * Only round trips whose entry recorded `lessonsShown` count (journal/lessonUse.ts); older
 * entries are "untracked", not "without". Like the scorecard this is numbers only, no verdict.
 * With few trades the honest answer is usually "too few to tell", so each lesson carries
 * caveats about its sample instead of a grade:
 *   - fewer than MIN_SIDE trades on either side cannot separate a lesson from luck;
 *   - "without" trades are mostly OLDER (a lesson exists only after it is written, usually
 *     after a loss), so a difference may be the market or other changes, not the lesson.
 *
 * A trip counts as "cited" when its entry OR its exit decision named the lesson. Skips and
 * holds never become round trips, so the decisions that cite a lesson there are only counted.
 *
 * P&L is after fees, the same reading as realTradeStats (learning/loop.ts): net when every fee
 * is known, else gross minus the fees that were reported. Alpaca bills most fees separately,
 * so there the number is often still close to gross; `feesIncomplete` says how many trips that is.
 */
import { computeOutcomes, pnlAfterCosts, type TradeOutcome } from './ledger';
import { readDecisions } from '../journal/journal';
import type { DecisionRecord } from '../journal/types';
import { r } from './metrics';

export const MIN_SIDE = 5;

export interface SideStats { trades: number; wins: number; winRate: number | null;
  /** Sum of P&L after the fees the fills report. */
  pnlAfterFees: number;
  /** Trips whose fills did not state every fee, so their P&L may still miss some costs. */
  feesIncomplete: number;
  expectancy: number | null; avgReturnPct: number | null }

export interface LessonOutcome { lessonId: string; withLesson: SideStats; withoutLesson: SideStats; cited: SideStats;
  /** Skip and hold decisions whose reason named this lesson. They have no P&L, so this is a count only. */
  citedBySkips: number; citedByHolds: number; caveats: string[] }

export interface LessonOutcomeReport { tracked: number; untracked: number; pnlBasis: string; lessons: LessonOutcome[] }

const PNL_BASIS = 'P&L after fees: net when every fee is known, else gross minus the fees reported (the same reading as the signal report).';


function returnAfterCosts(o: TradeOutcome): number {
  const cost = o.entryPrice * o.qty;
  return Number.isFinite(cost) && cost > 0 ? pnlAfterCosts(o) / cost * 100 : o.returnPct;
}

function side(list: TradeOutcome[]): SideStats {
  const pnl = list.reduce((a, o) => a + pnlAfterCosts(o), 0);
  const wins = list.filter(o => pnlAfterCosts(o) > 0).length;
  return { trades: list.length, wins, winRate: list.length ? r(wins / list.length * 100) : null, pnlAfterFees: r(pnl)!,
    feesIncomplete: list.filter(o => !o.feesComplete).length,
    expectancy: list.length ? r(pnl / list.length) : null,
    avgReturnPct: list.length ? r(list.reduce((a, o) => a + returnAfterCosts(o), 0) / list.length) : null };
}

const citesOnTrip = (o: TradeOutcome, id: string) => !!(o.lessonsCited?.includes(id) || o.exitLessonsCited?.includes(id));

/** Pure part, for tests: compare outcomes by lesson. `decisions` adds the skip/hold citation counts. */
export function compareLessons(outcomes: TradeOutcome[], decisions: DecisionRecord[] = []): LessonOutcomeReport {
  const tracked = outcomes.filter(o => o.lessonsShown != null);
  const skipsAndHolds = decisions.filter(d => (d.kind === 'skip' || d.kind === 'hold') && d.lessonsCited?.length);
  const ids = [...new Set([
    ...tracked.flatMap(o => [...o.lessonsShown!, ...(o.lessonsCited ?? []), ...(o.exitLessonsCited ?? [])]),
    ...skipsAndHolds.flatMap(d => d.lessonsCited!),
  ])];
  const lessons = ids.map(id => {
    const withL = tracked.filter(o => o.lessonsShown!.includes(id));
    const withoutL = tracked.filter(o => !o.lessonsShown!.includes(id));
    const caveats: string[] = [];
    if (withL.length < MIN_SIDE || withoutL.length < MIN_SIDE)
      caveats.push(`Fewer than ${MIN_SIDE} trades with or without this lesson (${withL.length} vs ${withoutL.length}) — too few to tell it from luck.`);
    if (withoutL.length && withL.length) {
      const lastWithout = Math.max(...withoutL.map(o => Date.parse(o.entryAt)));
      const firstWith = Math.min(...withL.map(o => Date.parse(o.entryAt)));
      if (lastWithout <= firstWith) caveats.push('Every trade without this lesson came before the first trade with it, so a difference may be the market changing, not the lesson.');
    }
    const noFees = tracked.filter(o => !o.feesComplete).length;
    if (noFees) caveats.push(`${noFees} of ${tracked.length} trips have no full fee record (no after-fee P&L in the ledger), so their P&L is gross minus only the fees reported.`);
    const citing = skipsAndHolds.filter(d => d.lessonsCited!.includes(id));
    return { lessonId: id, withLesson: side(withL), withoutLesson: side(withoutL),
      cited: side(tracked.filter(o => citesOnTrip(o, id))),
      citedBySkips: citing.filter(d => d.kind === 'skip').length, citedByHolds: citing.filter(d => d.kind === 'hold').length, caveats };
  }).sort((a, b) => b.withLesson.trades - a.withLesson.trades);
  return { tracked: tracked.length, untracked: outcomes.length - tracked.length, pnlBasis: PNL_BASIS, lessons };
}

/** The comparison over closed round trips (and skips/holds), optionally only the last `days`. */
export function lessonOutcomes(opts: { days?: number } = {}): LessonOutcomeReport {
  const since = opts.days != null ? new Date(Date.now() - opts.days * 86_400_000) : undefined;
  const cutoff = since?.toISOString();
  const decisions = readDecisions({ filter: d => (d.kind === 'skip' || d.kind === 'hold') && !!d.lessonsCited?.length && (!cutoff || d.at >= cutoff) });
  return compareLessons(computeOutcomes({ since }), decisions);
}
