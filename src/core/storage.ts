/**
 * Account storage as plain files:
 *
 *   DATA_DIR/db/settings.json    account information: the bound broker account
 *   DATA_DIR/db/state.json       the app's temporary state (positions' stops, alerts, chat, usage, …)
 *   DATA_DIR/db/<kind>.jsonl     one line per record write: {"seq","id","at","value"}
 *
 * A record update appends a new line with the same id; the last line for an id wins, and
 * superseded lines are dropped the next time the file is loaded.
 *
 * Everything is held in memory and written through at the end of each transaction. A
 * transaction that throws is undone in memory and never reaches disk.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR, ensureDataDir } from './paths';
import { writeFileAtomic } from './fsAtomic';

interface Row { seq: number; id: string; at: string; json: string }

const DB_DIR = path.join(DATA_DIR, 'db');
const SETTINGS_FILE = path.join(DB_DIR, 'settings.json');
const STATE_FILE = path.join(DB_DIR, 'state.json');
const SETTINGS_KEYS = new Set(['account']);   // every other key is state
const fileFor = (key: string) => SETTINGS_KEYS.has(key) ? SETTINGS_FILE : STATE_FILE;
const recordFile = (kind: string) => path.join(DB_DIR, kind + '.jsonl');
const lineFor = (r: Row) => `{"seq":${r.seq},"id":${JSON.stringify(r.id)},"at":${JSON.stringify(r.at)},"value":${r.json}}\n`;

let opened = false;
let ephemeral = false;
let depth = 0;
let nextSeq = 1;
let values: Record<string, unknown> = {};
const kinds = new Map<string, Map<string, Row>>();   // insertion order = seq order
let dirtyFiles = new Set<string>();
let lines: Array<{ kind: string; line: string }> = [];
let undo: Array<() => void> = [];
let committed: Array<() => void> = [];
const activityListeners = new Set<(entry: any) => void>();

export function subscribeActivity(listener: (entry: any) => void): () => void {
  activityListeners.add(listener); return () => activityListeners.delete(listener);
}

function open(): void {
  if (opened) return;
  opened = true;
  if (ephemeral) return;
  ensureDataDir(DB_DIR);
  for (const file of [SETTINGS_FILE, STATE_FILE]) if (fs.existsSync(file)) Object.assign(values, JSON.parse(fs.readFileSync(file, 'utf8')));
  for (const name of fs.readdirSync(DB_DIR)) {
    if (!name.endsWith('.jsonl')) continue;
    const kind = name.slice(0, -6);
    const rows = new Map<string, Row>();
    const text = fs.readFileSync(recordFile(kind), 'utf8').split('\n').filter(l => l.trim());
    text.forEach((line, i) => {
      let e: any;
      try { e = JSON.parse(line); }
      catch { throw new Error(`${recordFile(kind)} line ${i + 1} is not valid JSON; repair or remove it before starting.`); }
      if (e.deleted) rows.delete(e.id);
      else rows.set(e.id, { seq: e.seq, id: e.id, at: e.at, json: JSON.stringify(e.value) });
      if (e.seq >= nextSeq) nextSeq = e.seq + 1;
    });
    const sorted = new Map([...rows.values()].sort((a, b) => a.seq - b.seq).map(r => [r.id, r]));
    kinds.set(kind, sorted);
    // Drop superseded lines so files do not grow with every update.
    if (text.length > sorted.size) writeFileAtomic(recordFile(kind), [...sorted.values()].map(lineFor).join(''));
  }
}

function rowsOf(kind: string): Map<string, Row> {
  let rows = kinds.get(kind);
  if (!rows) { rows = new Map(); kinds.set(kind, rows); }
  return rows;
}

function put(kind: string, row: Row): void {
  const rows = rowsOf(kind);
  const old = rows.get(row.id);
  rows.set(row.id, row);   // replacing a key keeps its position, so seq order holds
  lines.push({ kind, line: lineFor(row) });
  undo.push(() => { if (old) rows.set(old.id, old); else rows.delete(row.id); });
}

export function transaction<T>(fn: () => T): T {
  open();
  if (depth) return fn();
  depth++;
  let result!: T;
  try {
    result = fn();
  } catch (err) {
    for (const step of undo.reverse()) step();
    lines = []; undo = []; committed = []; dirtyFiles = new Set();
    throw err;
  } finally { depth--; }
  if (!ephemeral) {
    for (const { kind, line } of lines) fs.appendFileSync(recordFile(kind), line, { mode: 0o600 });
    for (const file of dirtyFiles) {
      const own = Object.fromEntries(Object.entries(values).filter(([key]) => fileFor(key) === file));
      writeFileAtomic(file, JSON.stringify(own, null, 2) + '\n');
    }
  }
  lines = []; undo = []; dirtyFiles = new Set();
  const callbacks = committed; committed = [];
  for (const callback of callbacks) { try { callback(); } catch { /* Views cannot roll back committed data. */ } }
  return result;
}

export function readValue<T>(key: string): T | undefined {
  open();
  return key in values ? structuredClone(values[key]) as T : undefined;
}

export function saveValue(key: string, value: unknown): void {
  transaction(() => {
    const had = key in values, old = values[key];
    values[key] = structuredClone(value ?? null);
    dirtyFiles.add(fileFor(key));
    undo.push(() => { if (had) values[key] = old; else delete values[key]; });
  });
}

export function deleteValue(key: string): void {
  transaction(() => {
    if (!(key in values)) return;
    const old = values[key];
    delete values[key];
    dirtyFiles.add(fileFor(key));
    undo.push(() => { values[key] = old; });
  });
}

/** Insert a record; an existing id is left untouched. Returns the record's seq. */
export function appendRecord(kind: string, id: string, at: string, value: unknown): number {
  return transaction(() => {
    const existing = rowsOf(kind).get(id);
    if (existing) return existing.seq;
    const seq = nextSeq++;
    put(kind, { seq, id, at, json: JSON.stringify(value) ?? 'null' });
    return seq;
  });
}

/** Insert or replace by id. A replaced record keeps its original seq and time. */
export function saveRecord(kind: string, id: string, value: unknown): void {
  transaction(() => {
    const old = rowsOf(kind).get(id);
    put(kind, { seq: old?.seq ?? nextSeq++, id, at: old?.at ?? new Date().toISOString(), json: JSON.stringify(value) ?? 'null' });
  });
}

export function deleteRecord(kind: string, id: string): void {
  transaction(() => {
    const rows = rowsOf(kind), old = rows.get(id);
    if (!old) return;
    rows.delete(id);
    lines.push({ kind, line: JSON.stringify({ seq: old.seq, id, deleted: true }) + '\n' });
    // Re-inserting would move it to the end, so rebuild the order.
    undo.push(() => { kinds.set(kind, new Map([...rows.values(), old].sort((a, b) => a.seq - b.seq).map(r => [r.id, r]))); });
  });
}

export function readRecord<T>(kind: string, id: string): T | undefined {
  open();
  const row = kinds.get(kind)?.get(id);
  return row ? JSON.parse(row.json) : undefined;
}

/** All records of a kind, oldest first; `limit` keeps the newest N, `after` skips seq ≤ it. */
export function readRecords<T>(kind: string, limit?: number, after = 0): T[] {
  open();
  if (limit === 0) return [];
  const rows = [...(kinds.get(kind)?.values() ?? [])].filter(r => r.seq > after);
  return (limit === undefined ? rows : rows.slice(-limit)).map(r => JSON.parse(r.json));
}

/** Query one kind: `where` filters parsed values, `desc` reads newest first, `limit` caps matches. */
export function listRecords<T>(kind: string, opts: { where?: (value: T) => boolean; desc?: boolean; limit?: number } = {}):
  Array<{ seq: number; id: string; at: string; value: T }> {
  open();
  const rows = [...(kinds.get(kind)?.values() ?? [])];
  if (opts.desc) rows.reverse();
  const out: Array<{ seq: number; id: string; at: string; value: T }> = [];
  for (const r of rows) {
    if (opts.limit !== undefined && out.length >= opts.limit) break;
    const value = JSON.parse(r.json) as T;
    if (!opts.where || opts.where(value)) out.push({ seq: r.seq, id: r.id, at: r.at, value });
  }
  return out;
}

export function readRecordPage<T>(kind: string, after: number, limit: number): T[] {
  open();
  return [...(kinds.get(kind)?.values() ?? [])].filter(r => r.seq > after).slice(0, limit)
    .map(r => ({ ...JSON.parse(r.json), seq: r.seq }));
}

/** Forget the in-memory copy; the next call reloads from disk. */
export function closeStorage(): void {
  opened = false; values = {}; kinds.clear(); nextSeq = 1;
  lines = []; undo = []; committed = []; depth = 0; dirtyFiles = new Set();
}

/** Erase every setting and record — for tests that need a clean account. */
export function resetStorage(): void {
  closeStorage();
  if (!ephemeral) fs.rmSync(DB_DIR, { recursive: true, force: true });
}

/** The replay harness never reads or writes the operator's data. */
export function useEphemeralStorage(): void { if (!ephemeral) { closeStorage(); ephemeral = true; } }
export function isEphemeralStorage(): boolean { return ephemeral; }
/** Replay only: start a scenario with no actions left over from the previous one. */
export function forgetEphemeralRecords(kind: string): void { if (ephemeral) kinds.delete(kind); }

export function appendActivity(value: { at: string; kind: string; text: string; level?: string; source?: string }): number {
  const seq = appendRecord('activity', require('crypto').randomUUID(), value.at, value);
  const publish = () => { for (const listener of activityListeners) { try { listener({ ...value, seq }); } catch {} } };
  if (depth) committed.push(publish); else publish();
  return seq;
}
export function readActivity<T>(after: number, limit: number): T[] {
  return readRecordPage<T>('activity', after, limit);
}
