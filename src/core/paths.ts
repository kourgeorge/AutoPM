/**
 * Where the durable record lives — resolved once, in one place.
 *
 * Five modules persist here (`journal.ts`, `fillsLedger.ts`, `lessons.ts`, `state.ts`,
 * `sectorCache.ts`) and a sixth seeds a subdirectory of it (`policy/load.ts`). Each of them
 * used to compute `path.join(process.cwd(), 'data')` for itself, which made the location
 * unconfigurable in six places at once: pointing a run at a different directory meant editing
 * six files, and a seventh writer added later would have hardcoded a seventh copy.
 *
 * Now there is one declaration and one override:
 *
 *   DATA_DIR unset    →  <cwd>/data
 *   DATA_DIR=<path>   →  <path>, absolute or relative to cwd
 *
 * Nothing else feeds into it. In particular the ACTIVE BROKER does not: the directory is
 * whatever the operator names, so if two venues should keep separate histories that is said
 * once in the environment, not inferred here from a value that happens to correlate.
 *
 * This module imports NOTHING but node builtins and dotenv, on purpose. `config.ts` throws at
 * import time when `AI_API_KEY` is missing, and every persistence module would inherit that
 * throw if the data path came from there — turning a probe script or a one-off ledger read
 * into something that needs an LLM key to open a file.
 */

import fs from 'fs';
import path from 'path';
import * as dotenv from 'dotenv';

// Idempotent, and needed here because this module is imported before `config.ts` on some
// paths (a script that only touches the ledger never loads config at all).
dotenv.config();

function resolveDataDir(): string {
  const override = process.env.DATA_DIR?.trim();
  // `path.resolve` accepts both an absolute path and one relative to cwd, so the operator
  // does not have to know which we wanted.
  if (override) return path.resolve(process.cwd(), override);
  return path.join(process.cwd(), 'data');
}

/**
 * Absolute, so a log line naming it is unambiguous and no writer can be surprised by a later
 * `process.chdir`.
 */
export const DATA_DIR = resolveDataDir();

/**
 * Create the directory if it is absent. Every writer called this inline; it lives here now
 * because `writeFileAtomic` renames a temp file into place and throws ENOENT on a missing
 * parent, so "the directory exists" is a precondition several modules share and one of them
 * would eventually forget. Cheap enough to call on every write: one `existsSync` on a path
 * the OS has cached.
 *
 * Throws, like the `mkdirSync` it replaces — callers already wrap their writes and decide
 * what a failure means, which for all five is "log it, keep trading on in-memory truth".
 */
export function ensureDataDir(dir: string = DATA_DIR): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
