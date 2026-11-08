/**
 * Which code this engine is running: the last few commits, read from git ONCE when the engine
 * starts. A `git pull` without a restart (or without `npm run build` for `node dist/...`) leaves
 * the engine on the old code while the folder looks current — on 2026-11-08 that hid a whole
 * release from the operator. Reading git again on request tells the two apart: `behind` is true
 * when the folder has moved on since start-up, which means the engine needs a restart.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export interface Commit { hash: string; subject: string; date: string }
export interface EngineVersion {
  /** Commits the engine started with, newest first. Empty when git is unavailable. */
  commits: Commit[];
  startedAt: string;
  /** `src` under ts-node, `dist` for compiled code. */
  build: 'src' | 'dist';
  /** The folder's current HEAD, read now; null when git is unavailable. */
  headNow: string | null;
  /** True when the folder's HEAD is not what the engine started with: restart to run it. */
  behind: boolean;
  error?: string;
}

const ROOT = path.resolve(__dirname, '..', '..');
const SHOWN = 5;

function readCommits(limit: number): Commit[] {
  const out = execFileSync('git', ['log', `-${limit}`, '--format=%h%x1f%s%x1f%cI'], { cwd: ROOT, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  return out.trim().split('\n').filter(Boolean).map(line => {
    const [hash, subject, date] = line.split('\x1f');
    return { hash, subject, date };
  });
}

let started: { commits: Commit[]; error?: string } | null = null;
const startedAt = new Date().toISOString();

function atStart(): { commits: Commit[]; error?: string } {
  if (!started) {
    try { started = { commits: readCommits(SHOWN) }; }
    catch (err: any) { started = { commits: [], error: 'git is unavailable: ' + (err?.message ?? String(err)).split('\n')[0] }; }
  }
  return started;
}
/** Called at start-up, so the recorded commits are the ones the engine loaded. */
export function recordEngineVersion(): void { atStart(); }

let headCache: { at: number; hash: string | null } | null = null;
export function engineVersion(): EngineVersion {
  const start = atStart();
  // The dashboard polls status every few seconds; git is asked at most once a minute.
  if (!headCache || Date.now() - headCache.at > 60_000) {
    let hash: string | null = null;
    try { hash = readCommits(1)[0]?.hash ?? null; } catch { hash = null; }
    headCache = { at: Date.now(), hash };
  }
  const running = start.commits[0]?.hash ?? null;
  return {
    commits: start.commits, startedAt, build: __filename.endsWith('.ts') ? 'src' : 'dist',
    headNow: headCache.hash, behind: !!running && !!headCache.hash && headCache.hash !== running,
    ...(start.error ? { error: start.error } : {}),
  };
}
