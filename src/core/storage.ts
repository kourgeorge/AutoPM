/**
 * Account storage as plain files:
 *
 *   DATA_DIR/db/settings.json    account information: the bound broker account
 *   DATA_DIR/db/state.json       the app's temporary state (positions' stops, alerts, chat, usage, …)
 *   DATA_DIR/db/<kind>.jsonl     one line per record write: {"seq","id","at","value"}
 *   DATA_DIR/db/days/<YYYY-MM-DD>/tool-calls.jsonl
 *                                tool-call receipts, one folder per US Eastern day. A receipt goes
 *                                in the day its agent turn (request) was created, so a turn that
 *                                runs past midnight stays in one folder. Start-up loads only
 *                                today; older days load when a lookup needs them. The old single
 *                                db/tool-calls.jsonl is still read (never written) for older ids.
 *   DATA_DIR/db/days/ids.jsonl   which day holds a receipt whose id does not name its turn
 *   DATA_DIR/db/days/first-day.json  the day receipts began going to day folders
 *   DATA_DIR/db/evidence/<id>.json   a receipt a decision cites, kept after its day folder was
 *                                cleaned (see journal/retention.ts); a lookup by id finds it here first
 *   DATA_DIR/db/evidence/index.jsonl  one line per kept receipt (id, day, name, requestId), so
 *                                listings still show it in its old day, in time order
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
import { etNow } from './time';

/** `day`: '' = the old single file of a day kind, a date = that day folder, undefined = an ordinary kind. */
interface Row { seq: number; id: string; at: string; json?: string; offset?: number; length?: number; name?: string; requestId?: string; day?: string }

const DB_DIR = path.join(DATA_DIR, 'db');
const SETTINGS_FILE = path.join(DB_DIR, 'settings.json');
const STATE_FILE = path.join(DB_DIR, 'state.json');
const SETTINGS_KEYS = new Set(['account']);   // every other key is state
const fileFor = (key: string) => SETTINGS_KEYS.has(key) ? SETTINGS_FILE : STATE_FILE;
const recordFile = (kind: string) => path.join(DB_DIR, kind + '.jsonl');
/** Kinds split into day folders. */
const DAY_KINDS = new Set(['tool-calls']);
const DAYS_DIR = path.join(DB_DIR, 'days');
const DAY_INDEX = path.join(DAYS_DIR, 'ids.jsonl');
/** The first day receipts went to day folders: the old single file holds only turns up to it. */
const FIRST_DAY_FILE = path.join(DAYS_DIR, 'first-day.json');
const DAY_NAME = /^\d{4}-\d{2}-\d{2}$/;
/** How many recent days a query with no requestId and no `days` reads. */
export const RECENT_DAYS = 30;
const dayFile = (kind: string, day: string) => path.join(DAYS_DIR, day, kind + '.jsonl');
const fileOfRow = (kind: string, row: Row) => row.day ? dayFile(kind, row.day) : recordFile(kind);
const etDay = (at: string) => Number.isFinite(Date.parse(at)) ? etNow(new Date(at)).date : undefined;
const todayET = () => etNow(new Date()).date;
const daysBack = (day: string, n: number) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
};
const lineFor = (r: Row) => `{"seq":${r.seq},"id":${JSON.stringify(r.id)},"at":${JSON.stringify(r.at)},"value":${r.json}}\n`;

let opened = false;
let ephemeral = false;
let depth = 0;
let nextSeq = 1;
let values: Record<string, unknown> = {};
const kinds = new Map<string, Map<string, Row>>();   // insertion order = seq order
let dirtyFiles = new Set<string>();
let lines: Array<{ file: string; line: string; row?: Row }> = [];
const loadedDays = new Map<string, Set<string>>();   // day kind -> days in memory ('' = the old file)
let dayIndex = new Map<string, string>();            // `${kind} ${id}` -> day, for ids that do not name their turn
let firstDay = '';                                   // switch-over day: the old file only holds turns up to it
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
  const fd = fs.openSync(fileOfRow(kind, row), 'r');
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

/**
 * Each record line of a file. A torn last line is a write the process died in the middle of:
 * nothing after it was committed, so dropping it loses only that unfinished write. A bad line
 * anywhere else is damage, and still stops startup.
 */
function eachEntry(file: string, fn: (e: any, offset: number, length: number) => void): void {
  let torn: { index: number; offset: number } | undefined;
  eachLine(file, (line, i, offset, length) => {
    if (torn) throw new Error(`${file} line ${torn.index + 1} is not valid JSON; repair or remove it before starting.`);
    let e: any;
    try { e = JSON.parse(line); }
    catch { torn = { index: i, offset }; return; }
    fn(e, offset, length);
  });
  if (torn) {
    fs.copyFileSync(file, file + '.torn-' + Date.now());
    fs.truncateSync(file, torn.offset);
    console.error(`[Storage] ${file}: dropped an unfinished last line (a copy of the file was kept beside it).`);
  }
}

/** The live rows of one record file. */
function fileRows(file: string, day?: string): Map<string, Row> {
  const rows = new Map<string, Row>();
  eachEntry(file, (e, offset, length) => {
    if (e.deleted) rows.delete(e.id);
    else rows.set(e.id, { seq: e.seq, id: e.id, at: e.at, offset, length, day, ...indexed(e.value) });
    if (e.seq >= nextSeq) nextSeq = e.seq + 1;
  });
  return rows;
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
      if (DAY_KINDS.has(kind)) continue;   // the old single file is read only when a lookup needs it
      const rows = fileRows(recordFile(kind));
      kinds.set(kind, new Map([...rows.values()].sort((a, b) => a.seq - b.seq).map(r => [r.id, r])));
    }
    if (fs.existsSync(DAY_INDEX)) eachEntry(DAY_INDEX, e => { if (typeof e?.id === 'string' && DAY_NAME.test(e.day)) dayIndex.set(`${e.kind} ${e.id}`, e.day); });
    opened = true;
    const today = todayET();
    firstDay = readFirstDay() ?? dayFolders().sort()[0] ?? today;
    for (const kind of DAY_KINDS) loadDay(kind, today);
  } catch (err) { closeStorage(); throw err; }
}

function readFirstDay(): string | undefined {
  try { const day = JSON.parse(fs.readFileSync(FIRST_DAY_FILE, 'utf8')).day; return DAY_NAME.test(day) ? day : undefined; }
  catch { return undefined; }
}

/** Day folders on disk, any kind. */
function dayFolders(): string[] {
  try { return fs.readdirSync(DAYS_DIR).filter(name => DAY_NAME.test(name)); } catch { return []; }
}

/** Bring one day ('' = the old single file) of a day kind into memory, once. */
function loadDay(kind: string, day: string): void {
  let loaded = loadedDays.get(kind);
  if (!loaded) { loaded = new Set(); loadedDays.set(kind, loaded); }
  if (loaded.has(day)) return;
  loaded.add(day);
  if (ephemeral) return;
  const file = day ? dayFile(kind, day) : recordFile(kind);
  if (!fs.existsSync(file)) return;
  const rows = rowsOf(kind);
  for (const row of fileRows(file, day).values()) {
    const old = rows.get(row.id);
    // An id saved again on a later day lives in that later folder; the old file never wins.
    if (!old || (day && (old.day ?? '') < day)) rows.set(row.id, row);
  }
}

/** The day of a request's start (when it was created), if the request is known. */
function requestDay(requestId: string): string | undefined {
  const row = kinds.get('requests')?.get(requestId);
  return row ? etDay(row.at) : undefined;
}
/** A tool call id is `<turnId>:<round>:<index>`; its turn tells the day. */
function turnDay(id: string): string | undefined {
  const m = /^(.+):\d+:\d+$/.exec(id);
  return m ? requestDay(m[1]) : undefined;
}

/** Load whatever day may hold this id: its turn's day, its indexed day, else the old single file. */
function locate(kind: string, id: string): void {
  if (!DAY_KINDS.has(kind)) return;
  const fromId = turnDay(id), indexedDay = dayIndex.get(`${kind} ${id}`);
  if (fromId) loadDay(kind, fromId);
  if (indexedDay) loadDay(kind, indexedDay);
  if (!rowsOf(kind).has(id) && (!fromId || fromId <= firstDay)) loadDay(kind, '');
}

/** The day folder a receipt is in, or would be written to. */
function writeDay(kind: string, id: string, value: any): string {
  return turnDay(id) ?? (typeof value?.requestId === 'string' ? requestDay(value.requestId) : undefined)
    ?? (rowsOf(kind).get(id)?.day || todayET());
}

/** The day folder (YYYY-MM-DD) that holds, or will hold, this receipt — for files kept beside it. */
export function recordDay(kind: string, id: string): string {
  open();
  locate(kind, id);
  return rowsOf(kind).get(id)?.day || writeDay(kind, id, undefined);
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
  const value = JSON.parse(row.json!);
  if (DAY_KINDS.has(kind)) placeInDay(kind, row, value);
  const old = rows.get(row.id);
  Object.assign(row, indexed(value));
  rows.set(row.id, row);   // replacing a key keeps its position, so seq order holds
  lines.push({ file: fileOfRow(kind, row), line: lineFor(row), row });
  undo.push(() => { if (old) rows.set(old.id, old); else rows.delete(row.id); });
}

/** Choose the day folder of a receipt write; ids that do not name their turn get an index line. */
function placeInDay(kind: string, row: Row, value: any): void {
  const fromId = turnDay(row.id), day = writeDay(kind, row.id, value);
  loadDay(kind, day);
  row.day = day;
  const key = `${kind} ${row.id}`, had = dayIndex.get(key);
  if (day === fromId || had === day) return;
  dayIndex.set(key, day);
  // Before the receipt line: a crash between the two leaves an index entry to an absent row, which is harmless.
  lines.push({ file: DAY_INDEX, line: JSON.stringify({ kind, id: row.id, day }) + '\n' });
  undo.push(() => { if (had === undefined) dayIndex.delete(key); else dayIndex.set(key, had); });
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
      for (const entry of lines) byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry]);
      for (const [file, entries] of byFile) {
        if (path.dirname(file) !== DB_DIR) {
          fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          // Saved before the first receipt line, so a later old-era day folder cannot move it.
          if (!fs.existsSync(FIRST_DAY_FILE)) writeFileAtomic(FIRST_DAY_FILE, JSON.stringify({ day: firstDay }) + '\n');
        }
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
    locate(kind, id);
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
    locate(kind, id);
    const old = rowsOf(kind).get(id);
    put(kind, { seq: old?.seq ?? nextSeq++, id, at: old?.at ?? new Date().toISOString(), json: JSON.stringify(value) ?? 'null' });
  });
}

export function deleteRecord(kind: string, id: string): void {
  transaction(() => {
    locate(kind, id);
    const rows = rowsOf(kind), old = rows.get(id);
    if (!old) return;
    if (old.day === '') throw new Error(`Old ${kind} receipts in the single file are read-only`);
    rows.delete(id);
    lines.push({ file: fileOfRow(kind, old), line: JSON.stringify({ seq: old.seq, id, deleted: true }) + '\n' });
    // Re-inserting would move it to the end, so rebuild the order.
    undo.push(() => { kinds.set(kind, new Map([...rows.values(), old].sort((a, b) => a.seq - b.seq).map(r => [r.id, r]))); });
  });
}

export function readRecord<T>(kind: string, id: string): T | undefined {
  open();
  const kept = DAY_KINDS.has(kind) ? readKept<T>(id) : undefined;
  if (kept) return kept.value;
  locate(kind, id);
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
export interface RecordQuery<T> {
  name?: string; requestId?: string; where?: (value: T) => boolean; desc?: boolean; limit?: number;
  /** Day kinds, no requestId: how many recent days to read (default RECENT_DAYS; Infinity = all). */
  days?: number;
  /** Day kinds: filled in with the oldest day read and whether older receipts were left unread. */
  window?: QueryWindow;
}
export interface QueryWindow { since?: string | null; cutShort?: boolean }
export function* iterateRecords<T>(kind: string, opts: RecordQuery<T> = {}):
  Generator<{ seq: number; id: string; at: string; value: T }> {
  open();
  if (DAY_KINDS.has(kind)) { yield* iterateDays<T>(kind, opts); return; }
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

/**
 * A day kind is read one day at a time. With a requestId only its turn's day (and the old file,
 * for turns up to the switch-over) is opened; otherwise only the recent `days`.
 */
function* iterateDays<T>(kind: string, opts: RecordQuery<T>): Generator<{ seq: number; id: string; at: string; value: T }> {
  const loaded = () => loadedDays.get(kind) ?? new Set<string>();
  const oldFile = !ephemeral && fs.existsSync(recordFile(kind));
  let segments: string[], since: string | undefined, cutShort = false;
  if (opts.requestId !== undefined) {
    const day = requestDay(opts.requestId);
    segments = day ? [day] : [...loaded()].filter(Boolean);
    if (!day || day <= firstDay) segments.push('');
  } else {
    const today = todayET(), span = opts.days ?? RECENT_DAYS;
    since = Number.isFinite(span) ? daysBack(today, Math.max(1, span) - 1) : undefined;
    const all = new Set([...dayFolders(), ...[...loaded()].filter(Boolean), today]);
    for (const k of keptIndex().values()) if (k.day) all.add(k.day);
    segments = [...all].filter(d => !since || d >= since);
    if ([...all].some(d => since && d < since)) cutShort = true;
    if (!since || since <= firstDay) segments.push(''); else if (oldFile) cutShort = true;
  }
  segments = [...new Set(segments)].sort();
  if (opts.desc) segments.reverse();
  const window = opts.window ?? {};
  Object.assign(window, { since: since ?? null, cutShort });
  // The old file has no day folders, so its rows are kept to the window by their own time.
  const inWindow = (r: Row) => {
    const day = r.day === '' && since ? etDay(r.at) : undefined;
    if (day && day < since!) { window.cutShort = true; return false; }
    return true;
  };
  let count = 0;
  for (const day of segments) {
    loadDay(kind, day);
    const live = rowsOf(kind);
    // Kept receipts whose day folder copy is gone are listed in that day, as if still there.
    const keptRows = [...keptIndex().values()].filter(k => k.day === day && !live.has(k.id));
    const rows = [...live.values(), ...keptRows].filter(r => (r.day ?? '') === day
      && (opts.name === undefined || r.name === opts.name)
      && (opts.requestId === undefined || r.requestId === opts.requestId) && inWindow(r))
      .sort((a, b) => a.seq - b.seq);
    if (opts.desc) rows.reverse();
    for (const r of rows) {
      if (opts.limit !== undefined && count >= opts.limit) return;
      const value = (live.get(r.id) === r ? payload(kind, r) : readKept<T>(r.id)?.value) as T;
      if (value === undefined) continue;
      if (!opts.where || opts.where(value)) {
        count++;
        yield { seq: r.seq, id: r.id, at: r.at, value };
      }
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

/*
 * Kept evidence: a receipt a recorded decision cites, copied out of its day folder before the
 * cleanup deletes that folder. One file per id; it is read-only and wins over the day folder copy
 * (its scan snapshot is written into it, so it still pages once the snapshot files are gone).
 */
const EVIDENCE_DIR = path.join(DB_DIR, 'evidence');
const keptFile = (id: string) => path.join(EVIDENCE_DIR, id.replace(/[^\w.-]/g, '_') + '.json');
const KEPT_INDEX = path.join(EVIDENCE_DIR, 'index.jsonl');
let keptNames: Set<string> | undefined;   // file names in evidence/, read once
let kept: Map<string, Row> | undefined;   // id -> where a kept receipt is listed, read once
export interface KeptRecord<T = unknown> { id: string; seq: number; at: string; value: T }

function readKept<T>(id: string): KeptRecord<T> | undefined {
  if (ephemeral) return undefined;
  if (!keptNames) { try { keptNames = new Set(fs.readdirSync(EVIDENCE_DIR)); } catch { keptNames = new Set(); } }
  const file = keptFile(id);
  if (!keptNames.has(path.basename(file))) return undefined;
  try {
    const kept = JSON.parse(fs.readFileSync(file, 'utf8')) as KeptRecord<T>;
    return kept?.id === id ? kept : undefined;
  } catch { return undefined; }
}
/** Kept receipts as listing rows. Files saved before the index existed are read once to fill it in. */
function keptIndex(): Map<string, Row> {
  if (kept) return kept;
  kept = new Map();
  if (ephemeral) return kept;
  if (fs.existsSync(KEPT_INDEX)) eachEntry(KEPT_INDEX, e => { if (typeof e?.id === 'string' && typeof e.day === 'string') kept!.set(e.id, e); });
  let names: string[] = [];
  try { names = fs.readdirSync(EVIDENCE_DIR).filter(n => n.endsWith('.json')); } catch { /* none kept */ }
  const listed = new Set([...kept.keys()].map(id => path.basename(keptFile(id))));
  for (const name of names) {
    if (listed.has(name)) continue;
    try {
      const k = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, name), 'utf8')) as KeptRecord<any>;
      const day = etDay(k.at);
      if (typeof k?.id === 'string' && day) kept.set(k.id, { seq: k.seq, id: k.id, at: k.at, day, ...indexed(k.value) });
    } catch { /* unreadable: still found by id if it ever parses */ }
  }
  return kept;
}

/** The kept copy of a day-kind receipt, if one was saved to db/evidence/. */
export function keptRecord<T>(kind: string, id: string): KeptRecord<T> | undefined {
  open();
  return DAY_KINDS.has(kind) ? readKept<T>(id) : undefined;
}
/** Save a receipt to db/evidence/<id>.json, where lookups by id find it after its day folder is gone. */
export function keepRecord(kind: string, record: KeptRecord): void {
  if (!DAY_KINDS.has(kind)) throw new Error(`Only ${[...DAY_KINDS].join(', ')} receipts are kept as evidence`);
  open();
  if (ephemeral) return;
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  locate(kind, record.id);
  const day = rowsOf(kind).get(record.id)?.day || etDay(record.at) || todayET();
  const file = keptFile(record.id);
  writeFileAtomic(file, JSON.stringify(record) + '\n');
  keptNames?.add(path.basename(file));
  const row: Row = { seq: record.seq, id: record.id, at: record.at, day, ...indexed(record.value) };
  // After the file: a crash between the two leaves a file the index misses, which keptIndex() reads.
  fs.appendFileSync(KEPT_INDEX, JSON.stringify(row) + '\n', { mode: 0o600 });
  keptIndex().set(record.id, row);
}

/** Day folders on disk (YYYY-MM-DD), oldest first. */
export function listDayFolders(): string[] {
  return ephemeral ? [] : dayFolders().sort();
}
/** Where a day folder is, for files kept beside its receipts. */
export function dayFolderPath(day: string): string {
  if (!DAY_NAME.test(day)) throw new Error('Not a day folder: ' + day);
  return path.join(DAYS_DIR, day);
}
/** The receipts saved in one day folder, read from disk without loading them into memory. */
export function dayRecords<T>(kind: string, day: string): Array<KeptRecord<T>> {
  open();
  const file = dayFile(kind, day);
  if (!DAY_KINDS.has(kind) || ephemeral || !fs.existsSync(file)) return [];
  return [...fileRows(file, day).values()].sort((a, b) => a.seq - b.seq)
    .map(r => ({ id: r.id, seq: r.seq, at: r.at, value: payload(kind, r) as T }));
}
/** Delete one day folder's receipts file and forget its rows. Kept evidence is not touched. */
export function deleteDayRecords(kind: string, day: string): void {
  open();
  if (!DAY_KINDS.has(kind) || ephemeral) return;
  if (depth) throw new Error('Day folders cannot be deleted inside a transaction');
  const rows = rowsOf(kind);
  for (const [id, row] of rows) if (row.day === day) rows.delete(id);
  let loaded = loadedDays.get(kind);
  if (!loaded) { loaded = new Set(); loadedDays.set(kind, loaded); }
  loaded.add(day);   // nothing left to load from it
  fs.rmSync(dayFile(kind, day), { force: true });
}

/** Forget the in-memory copy; the next call reloads from disk. */
export function closeStorage(): void {
  opened = false; values = {}; kinds.clear(); nextSeq = 1; keptNames = undefined; kept = undefined;
  loadedDays.clear(); dayIndex = new Map(); firstDay = '';
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
export function forgetEphemeralRecords(kind: string): void { if (ephemeral) { kinds.delete(kind); loadedDays.delete(kind); } }

export function appendActivity(value: { at: string; kind: string; text: string; level?: string; source?: string }): number {
  const seq = appendRecord('activity', require('crypto').randomUUID(), value.at, value);
  const publish = () => { for (const listener of activityListeners) { try { listener({ ...value, seq }); } catch {} } };
  if (depth) committed.push(publish); else publish();
  return seq;
}
export function readActivity<T>(after: number, limit: number): T[] {
  return readRecordPage<T>('activity', after, limit);
}
