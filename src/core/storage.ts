/**
 * Account storage as plain files:
 *
 *   DATA_DIR/db/settings.json    account information: the bound broker account
 *   DATA_DIR/db/state.json       the app's temporary state (positions' stops, alerts, chat, usage, …)
 *   DATA_DIR/db/<kind>.jsonl     one line per record write: {"seq","id","at","value"}
 *
 * A record update appends a new line with the same id; the last line for an id wins, and
 * superseded lines remain on disk; the in-memory index points at the latest version.
 *
 * Only record metadata is held in memory; payloads are read from disk on demand. A
 * transaction that throws is undone in memory and never reaches disk.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR, ensureDataDir } from './paths';
import { writeFileAtomic } from './fsAtomic';

interface Row { seq: number; id: string; at: string; json?: string; offset?: number; length?: number; name?: string; requestId?: string }

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
let lines: Array<{ kind: string; line: string; row?: Row }> = [];
let undo: Array<() => void> = [];
let committed: Array<() => void> = [];
const activityListeners = new Set<(entry: any) => void>();

export function subscribeActivity(listener: (entry: any) => void): () => void {
  activityListeners.add(listener); return () => activityListeners.delete(listener);
}

/**
 * Each non-blank line of a file, read in chunks. A file is never read as one string: Node caps a
 * string at 512 MB, and trajectories.jsonl reached 724 MB on 2026-10-26, which stopped startup.
 */
function eachLine(file: string, fn: (line: string, index: number, offset: number, length: number) => void): void {
  const fd = fs.openSync(file, 'r'), chunk = Buffer.alloc(16 * 1024 * 1024);
  let parts: Buffer[] = [], index = 0, offset = 0, read: number;
  const emit = (buf: Buffer) => {
    const line = buf.toString('utf8');
    if (line.trim()) fn(line, index++, offset, buf.length);
    offset += buf.length + 1;
  };
  try {
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      let start = 0;
      for (let nl = chunk.indexOf(10, start); nl !== -1 && nl < read; nl = chunk.indexOf(10, start)) {
        emit(Buffer.concat([...parts, chunk.subarray(start, nl)])); parts = []; start = nl + 1;
      }
      if (start < read) parts.push(Buffer.from(chunk.subarray(start, read)));
    }
    if (parts.length) emit(Buffer.concat(parts));
  } finally { fs.closeSync(fd); }
}

/** Read one payload without retaining it in the index. Pending writes stay in memory. */
function payload(kind: string, row: Row): any {
  if (row.json !== undefined) return JSON.parse(row.json);
  const fd = fs.openSync(recordFile(kind), 'r');
  try {
    const buf = Buffer.alloc(row.length!);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, row.offset! + read);
      if (!n) throw new Error(`Record ${kind}/${row.id} was truncated on disk`);
      read += n;
    }
    return JSON.parse(buf.toString('utf8')).value;
  } finally { fs.closeSync(fd); }
}

function open(): void {
  if (opened) return;
  if (ephemeral) { opened = true; return; }
  try {
    ensureDataDir(DB_DIR);
    for (const file of [SETTINGS_FILE, STATE_FILE]) if (fs.existsSync(file)) Object.assign(values, JSON.parse(fs.readFileSync(file, 'utf8')));
    for (const name of fs.readdirSync(DB_DIR)) {
      if (!name.endsWith('.jsonl')) continue;
      const kind = name.slice(0, -6);
      const rows = new Map<string, Row>();
      const file = recordFile(kind);
      // A torn last line is a write the process died in the middle of: nothing after it was
      // committed, so dropping it loses only that unfinished write. A bad line anywhere else is
      // damage, and still stops startup.
      let torn: { index: number; offset: number } | undefined;
      eachLine(file, (line, i, offset, length) => {
        if (torn) throw new Error(`${file} line ${torn.index + 1} is not valid JSON; repair or remove it before starting.`);
        let e: any;
        try { e = JSON.parse(line); }
        catch { torn = { index: i, offset }; return; }
        if (e.deleted) rows.delete(e.id);
        else rows.set(e.id, { seq: e.seq, id: e.id, at: e.at, offset, length, ...indexed(e.value) });
        if (e.seq >= nextSeq) nextSeq = e.seq + 1;
      });
      if (torn) {
        fs.copyFileSync(file, file + '.torn-' + Date.now());
        fs.truncateSync(file, torn.offset);
        console.error(`[Storage] ${file}: dropped an unfinished last line (a copy of the file was kept beside it).`);
      }
      const sorted = new Map([...rows.values()].sort((a, b) => a.seq - b.seq).map(r => [r.id, r]));
      kinds.set(kind, sorted);
    }
    opened = true;
  } catch (err) { closeStorage(); throw err; }
}

function rowsOf(kind: string): Map<string, Row> {
  let rows = kinds.get(kind);
  if (!rows) { rows = new Map(); kinds.set(kind, rows); }
  return rows;
}

/** The value fields kept in memory, so queries on them skip unrelated payloads before disk reads. */
function indexed(value: any): Pick<Row, 'name' | 'requestId'> {
  return { name: typeof value?.name === 'string' ? value.name : undefined,
    requestId: typeof value?.requestId === 'string' ? value.requestId : undefined };
}

function put(kind: string, row: Row): void {
  const rows = rowsOf(kind);
  const old = rows.get(row.id);
  const value = JSON.parse(row.json!);
  Object.assign(row, indexed(value));
  rows.set(row.id, row);   // replacing a key keeps its position, so seq order holds
  lines.push({ kind, line: lineFor(row), row });
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
    try {
      // One append per file: a crash can tear at most the last line of each, which `open`
      // recovers from. Offsets are known before writing, so rows are updated only once it lands.
      const byFile = new Map<string, typeof lines>();
      for (const entry of lines) {
        const file = recordFile(entry.kind);
        byFile.set(file, [...(byFile.get(file) ?? []), entry]);
      }
      for (const [file, entries] of byFile) {
        let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
        fs.appendFileSync(file, entries.map(e => e.line).join(''), { mode: 0o600 });
        for (const { line, row } of entries) {
          const length = Buffer.byteLength(line);
          if (row) { row.offset = offset; row.length = length - 1; delete row.json; }
          offset += length;
        }
      }
      for (const file of dirtyFiles) {
        const own = Object.fromEntries(Object.entries(values).filter(([key]) => fileFor(key) === file));
        writeFileAtomic(file, JSON.stringify(own, null, 2) + '\n');
      }
    } catch (err) {
      // Memory must not claim what the disk does not hold, and the failed lines must not ride
      // along with the next transaction. Anything partly on disk is reloaded from it.
      for (const step of undo.reverse()) step();
      lines = []; undo = []; committed = []; dirtyFiles = new Set();
      closeStorage();
      throw err;
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
  return row ? payload(kind, row) : undefined;
}

/** All records of a kind, oldest first; `limit` keeps the newest N, `after` skips seq ≤ it. */
export function readRecords<T>(kind: string, limit?: number, after = 0): T[] {
  open();
  if (limit === 0) return [];
  const rows = [...(kinds.get(kind)?.values() ?? [])].filter(r => r.seq > after);
  return (limit === undefined ? rows : rows.slice(-limit)).map(r => payload(kind, r));
}

/** Query one kind without retaining payloads that the caller has already consumed.
 * `name` and `requestId` use indexed value metadata to skip unrelated payloads before disk reads.
 */
export interface RecordQuery<T> { name?: string; requestId?: string; where?: (value: T) => boolean; desc?: boolean; limit?: number }
export function* iterateRecords<T>(kind: string, opts: RecordQuery<T> = {}):
  Generator<{ seq: number; id: string; at: string; value: T }> {
  open();
  const rows = [...(kinds.get(kind)?.values() ?? [])];
  if (opts.desc) rows.reverse();
  let count = 0;
  for (const r of rows) {
    if (opts.limit !== undefined && count >= opts.limit) break;
    if (opts.name !== undefined && r.name !== opts.name) continue;
    if (opts.requestId !== undefined && r.requestId !== opts.requestId) continue;
    const value = payload(kind, r) as T;
    if (!opts.where || opts.where(value)) {
      count++;
      yield { seq: r.seq, id: r.id, at: r.at, value };
    }
  }
}

/** Matching records, collected for callers that need an array. */
export function listRecords<T>(kind: string, opts: RecordQuery<T> = {}):
  Array<{ seq: number; id: string; at: string; value: T }> {
  return [...iterateRecords<T>(kind, opts)];
}

export function readRecordPage<T>(kind: string, after: number, limit: number): T[] {
  open();
  return [...(kinds.get(kind)?.values() ?? [])].filter(r => r.seq > after).slice(0, limit)
    .map(r => ({ ...payload(kind, r), seq: r.seq }));
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
