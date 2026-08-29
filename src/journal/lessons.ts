/**
 * L5 — the lessons file.
 *
 * Free-text markdown in `data/LESSONS.md`, appended synchronously, never rewritten.
 *
 * The decision journal records what was DECIDED; `review/metrics.ts` measures what
 * WORKED. Neither holds a CONCLUSION. `runCycle` builds a fresh `messages` array every
 * cycle, so an inference the model drew from a scorecard dies the moment that cycle ends —
 * the loop measures, interprets, and forgets. This file is the only edge that carries an
 * interpretation into the next cycle.
 *
 * Markdown, not JSONL like its two neighbours, because a lesson has no fields worth
 * querying. It is prose addressed to the next cycle, and the operator is expected to read
 * and edit it by hand — which a line of JSON actively discourages.
 *
 * There is no pruning, no dedup and no cap on the file. The bar is the bound: most cycles
 * must add nothing. If that stops being true the file says so in plain sight, which is the
 * cheapest possible detector.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../core/logger';
import { getPolicy } from '../policy/load';
import { DATA_DIR, ensureDataDir } from '../core/paths';

export const LESSONS_FILE = path.join(DATA_DIR, 'LESSONS.md');

/**
 * Written once, when the file is created. The operator opens this file more often than any
 * source file, and the standard it is held to belongs in it rather than only in POLICY.md.
 */
const FILE_HEADER = `# LESSONS

What this system got wrong and what changed as a result. Append-only, oldest first.

A lesson is a CHANGED RULE OF THUMB, not a diary entry. "XLE gapped on an OPEC headline
nobody checked, so energy entries need a scheduled-events check" is a lesson. "The tape was
choppy" is noise. Most cycles add nothing here, and that is correct — a file that grows
every cycle is a file nobody rereads.

Hand-editing is expected: delete a lesson that turned out wrong. An entry begins at its
\`## <timestamp> — policy vN\` heading and runs to the next one, so a lesson added by hand
needs a heading in that form to be read at all. Nothing reads this file but the trader's
cycle context, and nothing writes it but \`write_lesson\`.
`;

let _ephemeral = false;

/** Stop writing to disk, permanently for this process. Mirrors `useEphemeralJournal`. */
export function useEphemeralLessons(): void {
  _ephemeral = true;
}

/**
 * Append one lesson. Returns the text as stored.
 *
 * A write failure is logged and swallowed, for the same reason `recordDecision` swallows
 * one: this is a witness, not a participant. A full disk must not turn a cycle that
 * concluded something into a cycle that threw.
 */
export function recordLesson(text: string): string {
  const body = text.trim();
  if (body === '') throw new Error('A lesson cannot be empty.');

  const entry = `\n## ${new Date().toISOString()} — policy v${getPolicy().version}\n\n${body}\n`;

  if (!_ephemeral) {
    try {
      ensureDataDir();
      if (!fs.existsSync(LESSONS_FILE)) fs.writeFileSync(LESSONS_FILE, FILE_HEADER, 'utf8');
      fs.appendFileSync(LESSONS_FILE, entry, 'utf8');
    } catch (err: any) {
      logger.error(`[Lessons] write failed: ${err.message}`);
    }
  }

  logger.info(`[Lessons] ${body.split('\n')[0]}`);
  return body;
}

/**
 * The entry boundary: a level-2 heading whose text starts with an ISO timestamp, which is
 * exactly what `recordLesson` writes and nothing else in a body plausibly is.
 *
 * This used to split on bare `^## `, on the assumption that a `## ` inside a body would be
 * rare and cosmetic when it happened. It is neither: the model opens essentially every
 * lesson with a `## ` title line, so each entry was cut into a bare header section and an
 * orphaned body. That halved the number of lessons the 20-section cap in `trader.ts` could
 * fit, and severed every lesson from the date and policy version it was written under —
 * while several lessons refer to those versions by name.
 *
 * The cost is a contract the operator has to know: a hand-added lesson needs a
 * `## <iso> — policy v<n>` header to be seen at all. `FILE_HEADER` says so, since the
 * operator reads that file far more often than this one.
 */
const ENTRY_HEADER = /^## \d{4}-\d{2}-\d{2}T/;

/**
 * Every lesson, oldest first, each as the raw markdown of its own section — header line
 * included, and any `## ` the body uses for itself left alone inside it.
 */
export function readLessons(): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(LESSONS_FILE, 'utf8');
  } catch {
    return [];
  }

  // A lookahead split, so the header stays attached to the section it opens. Sections are
  // then kept or dropped by testing them, rather than by assuming the file header is first:
  // anything that is not an entry — the file header, an operator's loose note — is not a
  // lesson, wherever in the file it sits.
  return raw
    .split(/^(?=## \d{4}-\d{2}-\d{2}T)/m)
    .map((s) => s.trim())
    .filter((s) => ENTRY_HEADER.test(s));
}
