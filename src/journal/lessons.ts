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
import { DATA_DIR } from './journal';

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

Hand-editing is expected: delete a lesson that turned out wrong. Nothing reads this file
but the trader's cycle context, and nothing writes it but \`write_lesson\`.
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
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
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
 * Every lesson, oldest first, each as the raw markdown of its own section.
 *
 * Splitting on `^## ` means a hand-written `## ` inside a body reads as two lessons. That
 * is the whole failure mode, it is cosmetic, and the alternative is a delimiter the
 * operator would have to know about to edit the file safely.
 */
export function readLessons(): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(LESSONS_FILE, 'utf8');
  } catch {
    return [];
  }

  return raw
    .split(/^## /m)
    .slice(1) // the file header, which is not a lesson
    .map((s) => '## ' + s.trim())
    .filter((s) => s !== '##');
}
