import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** An operational lock, outside the account data model. Acquire before importing storage. */
export function acquireEngineLock(dataDir: string): () => void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const directory = path.join(fs.realpathSync(dataDir), '.engine-lock');
  const ownerFile = path.join(directory, 'owner.json');
  const token = crypto.randomUUID();
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    let owner = 'another engine';
    try { owner = `engine PID ${JSON.parse(fs.readFileSync(ownerFile, 'utf8')).pid}`; } catch {}
    throw new Error(`Account storage is locked by ${owner}: ${directory}. Connect with start:tui or start:web instead. If an engine crashed, verify it has stopped before removing this lock directory.`);
  }
  try { fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }), { mode: 0o600 }); }
  catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (JSON.parse(fs.readFileSync(ownerFile, 'utf8')).token === token) fs.rmSync(directory, { recursive: true });
    } catch { /* A cleanup failure must not obscure the shutdown error. */ }
  };
}
