/**
 * Whole-file writes that a crash cannot truncate.
 *
 * `fs.writeFileSync` truncates the target and then writes, so a crash — or a full disk —
 * mid-write leaves a half-written file where a complete one used to be. `rename` within a
 * filesystem is atomic, so writing a sibling temp file and renaming it over the target means
 * a reader only ever sees the old contents or the new ones, never a prefix of the new.
 *
 * This exists as one function because three files needed it and only one had it: `policy.yaml`
 * is read by every startup path, `data/state.json` is rewritten on a debounce many times a
 * minute and its loader treats a parse failure as "start fresh" (silently discarding every
 * position snapshot), and `data/sectors.json` is a cache. Three copies of a temp-and-rename
 * dance would be three chances to forget the unlink on failure.
 *
 * NOT for the append-only writers (`journal.ts`, `lessons.ts`, `fillsLedger.ts`): an append
 * never truncates what is already on disk, so it is a different hazard class and a
 * rename-over would be actively wrong there.
 */

import fs from 'fs';

/**
 * Throws on failure, having cleaned up its temp file. Callers decide what a write failure
 * means — the policy writer reports it to the operator, the state and sector writers keep
 * going on in-memory truth.
 */
export function writeFileAtomic(file: string, contents: string): void {
  // Same directory, so the rename stays within one filesystem. PID-suffixed so two
  // processes pointed at one data dir cannot collide on the temp name.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}
