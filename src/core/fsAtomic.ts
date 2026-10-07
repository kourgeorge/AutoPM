/** Atomic replacement for regenerable cache files. Account data goes through `storage.ts`. */
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
