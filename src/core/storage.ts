import fs from 'fs';
import path from 'path';
import { DATA_DIR, ensureDataDir } from './paths';

interface Statement {
  run(...args: any[]): { lastInsertRowid: number | bigint; changes: number | bigint };
  get(...args: any[]): any;
  all(...args: any[]): any[];
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

let db: Database | undefined;
let depth = 0;
let failure: string | null = null;
let ephemeral = false;
const memory = new Map<string, unknown>();
const feedListeners = new Set<(entry: any) => void>();
let committed: Array<() => void> = [];
export function subscribeFeed(listener: (entry: any) => void): () => void {
  feedListeners.add(listener); return () => feedListeners.delete(listener);
}

/** One database per account worker. Writes are durable before returning. */
export function database(): Database {
  if (db) return db;
  ensureDataDir();
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string) => Database };
  db = new DatabaseSync(ephemeral ? ':memory:' : path.join(DATA_DIR, 'autotrade.sqlite'));
  if (!ephemeral) fs.chmodSync(path.join(DATA_DIR, 'autotrade.sqlite'), 0o600);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS records (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL,
      at TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(kind, id)
    );
    CREATE INDEX IF NOT EXISTS records_kind_seq ON records(kind, seq);
  `);
  return db;
}

export function transaction<T>(fn: () => T): T {
  if (ephemeral || depth) return fn();
  const d = database();
  d.exec('BEGIN IMMEDIATE');
  depth++;
  let result!: T;
  try {
    result = fn();
    d.exec('COMMIT');
    failure = null;
  } catch (err) {
    d.exec('ROLLBACK');
    committed = [];
    failure = err instanceof Error ? err.message : String(err);
    throw err;
  } finally { depth--; }
  const callbacks = committed; committed = [];
  for (const callback of callbacks) { try { callback(); } catch { /* Views cannot roll back committed data. */ } }
  return result;
}

export function readValue<T>(key: string): T | undefined {
  if (ephemeral) return memory.get(key) as T | undefined;
  const row = database().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : undefined;
}

export function saveValue(key: string, value: unknown): void {
  if (ephemeral) { memory.set(key, structuredClone(value)); return; }
  transaction(() => database().prepare(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run(key, JSON.stringify(value)));
}

export function appendRecord(kind: string, id: string, at: string, value: unknown): number {
  return transaction(() => {
    const result = database().prepare('INSERT OR IGNORE INTO records(kind,id,at,value) VALUES(?,?,?,?)')
      .run(kind, id, at, JSON.stringify(value));
    return Number(result.lastInsertRowid);
  });
}

export function readRecords<T>(kind: string, limit?: number, after = 0): T[] {
  const rows = limit === undefined
    ? database().prepare('SELECT value FROM records WHERE kind=? AND seq>? ORDER BY seq').all(kind, after)
    : database().prepare('SELECT value FROM (SELECT seq,value FROM records WHERE kind=? AND seq>? ORDER BY seq DESC LIMIT ?) ORDER BY seq')
      .all(kind, after, limit);
  return rows.map(row => JSON.parse(row.value));
}

export function readRecord<T>(kind: string, id: string): T | undefined {
  const row = database().prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, id);
  return row ? JSON.parse(row.value) : undefined;
}

export function saveRecord(kind: string, id: string, value: unknown): void {
  transaction(() => database().prepare('INSERT INTO records(kind,id,at,value) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value')
    .run(kind, id, new Date().toISOString(), JSON.stringify(value)));
}

/** Import once, in a transaction. Leave original files untouched for backup/inspection. */
export function importJsonLines(kind: string, file: string): void {
  const key = 'import:' + kind;
  if (readValue(key)) return;
  transaction(() => {
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim());
      lines.forEach((line, i) => {
        let value: any;
        try { value = JSON.parse(line); }
        catch { throw new Error(`Cannot import ${file}, line ${i + 1}: invalid JSON. Restore or repair this record before starting.`); }
        appendRecord(kind, value.execId ?? value.id ?? `legacy-${i}`, value.at ?? '', value);
      });
    }
    saveValue(key, true);
  });
}

export function storageHealth(): { ok: boolean; error: string | null } {
  return { ok: failure === null, error: failure };
}

export function closeStorage(): void {
  db?.close();
  db = undefined;
}

/** The replay harness never opens or migrates the operator's database. */
export function useEphemeralStorage(): void { if (!ephemeral) { closeStorage(); ephemeral = true; } }

export function appendFeed(value: { at: string; kind: string; text: string; level?: string }): number {
  const seq = appendRecord('feed', require('crypto').randomUUID(), value.at, value);
  const publish = () => { for (const listener of feedListeners) { try { listener({ ...value, seq }); } catch {} } };
  if (depth) committed.push(publish); else publish();
  return seq;
}
export function readFeed<T>(after: number, limit: number): T[] {
  return readRecordPage<T>('feed', after, limit);
}
export function readRecordPage<T>(kind: string, after: number, limit: number): T[] {
  return database().prepare('SELECT seq,value FROM records WHERE kind=? AND seq>? ORDER BY seq LIMIT ?')
    .all(kind, after, limit).map(row => ({ ...JSON.parse(row.value), seq: Number(row.seq) }));
}
