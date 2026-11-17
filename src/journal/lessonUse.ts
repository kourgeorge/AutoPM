/**
 * Which lessons a decision was made with, so the review layer can later ask whether a lesson
 * helped (review/lessonOutcomes.ts).
 *
 * What is stored, and why it stays small:
 *   lessonsShown  on ENTRY decisions only: the ids of the lessons in that cycle's LESSONS block.
 *                 Entries are the decisions a round trip is graded on, and they are rare, so
 *                 the up-to-30 ids cost about a kilobyte per entry and nothing on holds/skips.
 *   lessonsCited  on any decision: the shown lesson ids the trader named in its reason or
 *                 thesis. Usually empty, so usually not written at all.
 *
 * The ids are held in memory per request, as the cycle context is rendered. A request resumed
 * after a restart re-uses its saved conversation without re-rendering, so its decisions carry
 * no lesson ids: they count as "not tracked", never as "without the lesson".
 */

const MAX_REQUESTS = 50;
const shownByRequest = new Map<string, string[]>();

/** Called when a cycle context is rendered: these lessons are what this request reads. */
export function noteLessonsShown(requestId: string | undefined, lessonIds: string[]): void {
  if (!requestId) return;
  shownByRequest.delete(requestId);
  shownByRequest.set(requestId, [...new Set(lessonIds)]);
  while (shownByRequest.size > MAX_REQUESTS) shownByRequest.delete(shownByRequest.keys().next().value!);
}

export function lessonsShownTo(requestId: string | undefined): string[] | undefined {
  return requestId ? shownByRequest.get(requestId) : undefined;
}

/** The lesson fields a new decision in `requestId` should carry; empty when the request was never shown lessons. */
export function lessonLinks(kind: string, requestId: string | undefined, texts: Array<string | null | undefined>):
  { lessonsShown?: string[]; lessonsCited?: string[] } {
  const shown = lessonsShownTo(requestId);
  if (!shown) return {};
  const said = texts.filter(Boolean).join('\n');
  const cited = shown.filter(id => said.includes(id));
  return { ...(kind === 'entry' ? { lessonsShown: shown } : {}), ...(cited.length ? { lessonsCited: cited } : {}) };
}
