/** Every worker owns one private DATA_DIR; the account identity is verified at startup. */
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

export function ensureDataDir(dir: string = DATA_DIR): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
