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
 */
import { computeOutcomes, type TradeOutcome } from './ledger';
import { r } from './metrics';

export const MIN_SIDE = 5;

export interface SideStats { trades: number; wins: number; winRate: number | null; grossPnL: number;
  expectancy: number | null; avgReturnPct: number | null }

export interface LessonOutcome { lessonId: string; withLesson: SideStats; withoutLesson: SideStats; cited: SideStats; caveats: string[] }

export interface LessonOutcomeReport { tracked: number; untracked: number; lessons: LessonOutcome[] }

function side(list: TradeOutcome[]): SideStats {
  const gross = list.reduce((a, o) => a + o.grossPnL, 0);
  const wins = list.filter(o => o.grossPnL > 0).length;
  return { trades: list.length, wins, winRate: list.length ? r(wins / list.length * 100) : null, grossPnL: r(gross)!,
    expectancy: list.length ? r(gross / list.length) : null,
    avgReturnPct: list.length ? r(list.reduce((a, o) => a + o.returnPct, 0) / list.length) : null };
}

/** Pure part, for tests: compare outcomes by lesson. */
export function compareLessons(outcomes: TradeOutcome[]): LessonOutcomeReport {
  const tracked = outcomes.filter(o => o.lessonsShown != null);
  const ids = [...new Set(tracked.flatMap(o => [...o.lessonsShown!, ...(o.lessonsCited ?? [])]))];
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
    return { lessonId: id, withLesson: side(withL), withoutLesson: side(withoutL),
      cited: side(tracked.filter(o => o.lessonsCited?.includes(id))), caveats };
  }).sort((a, b) => b.withLesson.trades - a.withLesson.trades);
  return { tracked: tracked.length, untracked: outcomes.length - tracked.length, lessons };
}

/** The comparison over closed round trips, optionally only those exited in the last `days`. */
export function lessonOutcomes(opts: { days?: number } = {}): LessonOutcomeReport {
  const since = opts.days != null ? new Date(Date.now() - opts.days * 86_400_000) : undefined;
  return compareLessons(computeOutcomes({ since }));
}
