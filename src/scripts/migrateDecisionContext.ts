/** Offline, additive account migration. Does not import storage, brokers, or model providers. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { acquireEngineLock } from '../core/engineLock';

const MIGRATION = 'decision-context-v1';
const NEW_FILES = ['evidence', 'position-reviews', 'candidate-reviews', 'research-items', 'research-reviews', 'source-text', 'contexts', 'pages'];
interface Row { seq: number; id: string; at?: string; value?: any; deleted?: boolean }
interface Report { migration: string; status: string; at: string; dataDir: string; backupPath?: string; changedRecords: Record<string, number>; createdFiles: string[]; notes: string[] }
const own = (value: any, key: string) => Object.hasOwn(value, key);
const object = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = (value: any): string => JSON.stringify(value, (_key, v) => object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const hash = (value: Buffer) => crypto.createHash('sha256').update(value).digest('hex');

/** Original keys, values, ordering, IDs, quantities and timestamps must survive every edit. */
function assertAdditive(before: any, after: any): void {
  if (Array.isArray(before)) {
    assert.ok(Array.isArray(after)); assert.equal(before.length, after.length);
    before.forEach((v, i) => assertAdditive(v, after[i]));
  } else if (object(before)) {
    assert.ok(object(after));
    for (const key of Object.keys(before)) { assert.ok(own(after, key)); assertAdditive(before[key], after[key]); }
  } else assert.deepEqual(after, before);
}

export function migrateDecisionContext(directory: string, apply = false): Report {
  const dataDir = fs.realpathSync(directory), db = path.join(dataDir, 'db');
  if (!fs.statSync(db).isDirectory()) throw new Error('Existing account db directory required');
  const release = acquireEngineLock(dataDir);
  try {
    const originals = new Map<string, Buffer>(), rows = new Map<string, Row[]>();
    for (const name of fs.readdirSync(db).sort()) {
      const file = path.join(db, name);
      if (!fs.lstatSync(file).isFile()) throw new Error('Expected regular database file: ' + name);
      const bytes = fs.readFileSync(file); originals.set(name, bytes);
      if (name.endsWith('.jsonl')) {
        const parsed = bytes.toString('utf8').split(/\r?\n/).filter(line => line.trim()).map((line, i): Row => {
          const value = JSON.parse(line);
          if (!object(value) || !Number.isSafeInteger(value.seq) || value.seq < 1 || typeof value.id !== 'string' || (!value.deleted && !own(value, 'value'))) throw new Error(`Invalid record envelope: ${name}:${i + 1}`);
          return value;
        });
        rows.set(name, parsed);
      } else if (name.endsWith('.json')) JSON.parse(bytes.toString('utf8'));
    }
    const latest = (name: string) => {
      const map = new Map<string, any>();
      for (const row of rows.get(name + '.jsonl') ?? []) { if (row.deleted) map.delete(row.id); else map.set(row.id, row.value); }
      return map;
    };
    const at = new Date().toISOString();
    const report: Report = { migration: MIGRATION, status: apply ? 'applied' : 'preview', at, dataDir, changedRecords: {}, createdFiles: [],
      notes: ['Historical theses and context remain unknown unless explicitly recorded in a linked action or review.',
        'Legacy lessons without a review schedule are due for review at migration time; this is a new schedule, not their historical creation date.',
        'All original fields and record envelopes are preserved. No broker or model calls are made.'] };
    if (latest('migrations').has(MIGRATION)) return { ...report, status: 'already_applied' };
    const journal = latest('journal'), actions = latest('actions'), reviews = latest('position-reviews');
    const updates = new Map<string, Buffer>();
    const transform = (name: string, update: (value: any) => void) => {
      let count = 0;
      const changed = (rows.get(name) ?? []).map(row => {
        if (row.deleted || !object(row.value)) return row;
        const next = structuredClone(row); update(next.value); assertAdditive(row, next);
        if (stable(next) !== stable(row)) count++;
        return next;
      });
      if (count) { report.changedRecords[name] = count; updates.set(name, Buffer.from(changed.map(r => JSON.stringify(r)).join('\n') + '\n')); }
    };
    const fill = (value: any, key: string, fallback: any) => { if (!own(value, key)) value[key] = structuredClone(fallback); };
    const decisionContext = (value: any) => {
      const linked = value.actionId ? actions.get(value.actionId) : null;
      const signal = linked?.params?.signal;
      const sameSymbol = signal?.symbol && String(signal.symbol).toUpperCase() === String(value.symbol).toUpperCase();
      const review = value.reviewId ? reviews.get(value.reviewId) : null;
      fill(value, 'thesis', sameSymbol && object(signal.thesis) ? signal.thesis : null);
      fill(value, 'observationIds', sameSymbol && Array.isArray(signal.observationIds) ? signal.observationIds : Array.isArray(linked?.params?.observationIds) ? linked.params.observationIds : []);
      fill(value, 'reviewId', null);
      fill(value, 'contextVariant', review?.contextVariant ?? (sameSymbol ? signal.contextVariant : undefined) ?? 'legacy-unrecorded');
    };
    transform('journal.jsonl', decisionContext);
    const actionContext = (value: any) => {
      if (!object(value.params)) return;
      const decision = journal.get(value.decisionId ?? 'action-' + value.id);
      if (object(value.params.signal)) {
        fill(value.params.signal, 'thesis', decision?.thesis ?? null);
        fill(value.params.signal, 'observationIds', decision?.observationIds ?? []);
        fill(value.params.signal, 'contextVariant', decision?.contextVariant ?? 'legacy-unrecorded');
      } else if (value.kind === 'exit') fill(value.params, 'observationIds', decision?.observationIds ?? []);
    };
    transform('actions.jsonl', actionContext);
    transform('action-history.jsonl', value => { if (object(value.action)) actionContext(value.action); });
    transform('lessons.jsonl', value => {
      const ids: string[] = Array.isArray(value.evidenceIds) ? [...new Set<string>(value.evidenceIds)] : [];
      const known = ids.every(id => journal.has(id));
      fill(value, 'counterEvidenceIds', []); fill(value, 'reviewAfter', at);
      fill(value, 'scope', 'Legacy observation; applicability was not recorded');
      fill(value, 'sampleCount', known ? ids.length : null);
      const exits = ids.map(id => journal.get(id)).filter(d => d?.kind === 'exit' && d.executed);
      const fillsKnown = known && exits.every(d => d.filledQty > 0 || ['filled', 'executed'].includes(d.orderStatus));
      fill(value, 'completedExitCount', fillsKnown ? exits.length : null);
    });
    // Link only exact, unique historical receipts. Ambiguous or truncated results stay unknown.
    const receipts = new Map<string, string[]>();
    for (const [id, value] of latest('tool-calls')) {
      if (!object(value) || typeof value.result !== 'string') continue;
      const key = stable([value.requestId, value.name, value.input, value.result]);
      receipts.set(key, [...(receipts.get(key) ?? []), id]);
    }
    transform('transcripts.jsonl', value => {
      if (!Array.isArray(value.messages)) return;
      for (let i = 1; i < value.messages.length; i++) {
        const message = value.messages[i], previous = value.messages[i - 1];
        if (message.role !== 'user' || previous.role !== 'assistant' || !Array.isArray(message.content) || !Array.isArray(previous.content)) continue;
        for (const result of message.content) {
          if (result.type !== 'tool_result' || own(result, 'receiptId')) continue;
          const call = previous.content.find((b: any) => b.type === 'tool_use' && b.id === result.tool_use_id);
          if (!call) continue;
          const matches = receipts.get(stable([value.id, call.name, call.input, result.content]));
          if (matches?.length === 1) result.receiptId = matches[0];
        }
      }
    });
    if (!originals.has('state.json')) throw new Error('Existing account state.json required');
    const state = JSON.parse(originals.get('state.json')!.toString('utf8')), nextState = structuredClone(state);
    fill(nextState, 'economic-calendar', null); assertAdditive(state, nextState);
    if (stable(state) !== stable(nextState)) { report.changedRecords['state.json'] = 1; updates.set('state.json', Buffer.from(JSON.stringify(nextState, null, 2) + '\n')); }
    for (const kind of NEW_FILES) if (!originals.has(kind + '.jsonl')) { updates.set(kind + '.jsonl', Buffer.alloc(0)); report.createdFiles.push(kind + '.jsonl'); }
    if (!apply) return report;

    const backup = path.join(dataDir, 'backups', `${MIGRATION}-${at.replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 }); report.backupPath = backup;
    const manifest: Record<string, string> = {};
    for (const [name, bytes] of originals) { fs.writeFileSync(path.join(backup, name), bytes, { mode: 0o600, flag: 'wx' }); manifest[name] = hash(bytes); }
    fs.writeFileSync(path.join(backup, 'backup-manifest.json'), JSON.stringify({ at, dataDir, sha256: manifest }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    for (const [name, bytes] of originals) { assert.equal(hash(fs.readFileSync(path.join(backup, name))), hash(bytes)); assert.equal(hash(fs.readFileSync(path.join(db, name))), hash(bytes), 'Account changed before migration'); }
    const maxSeq = Math.max(0, ...[...rows.values()].flat().map(r => r.seq));
    const migrationRows = [...(rows.get('migrations.jsonl') ?? []), { seq: maxSeq + 1, id: MIGRATION, at, value: report }];
    updates.set('migrations.jsonl', Buffer.from(migrationRows.map(r => JSON.stringify(r)).join('\n') + '\n'));
    const written: string[] = [];
    try {
      for (const [name, bytes] of updates) {
        const file = path.join(db, name), temporary = file + `.migration-${process.pid}.tmp`;
        try { fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); written.push(name); }
        finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      }
      // Verify exact expected writes and all unchanged files before releasing the lock.
      for (const [name, bytes] of updates) assert.equal(hash(fs.readFileSync(path.join(db, name))), hash(bytes));
      for (const [name, bytes] of originals) if (!updates.has(name)) assert.equal(hash(fs.readFileSync(path.join(db, name))), hash(bytes));
      fs.writeFileSync(path.join(backup, 'migration-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    } catch (error) {
      for (const name of written.reverse()) {
        const bytes = originals.get(name), file = path.join(db, name);
        if (bytes) fs.writeFileSync(file, bytes, { mode: 0o600 }); else fs.unlinkSync(file);
      }
      throw error;
    }
    return report;
  } finally { release(); }
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2), index = args.indexOf('--data-dir');
    if (args.some((a, i) => !['--data-dir', '--apply'].includes(a) && i !== index + 1) || index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Usage: node dist/scripts/migrateDecisionContext.js --data-dir <account-directory> [--apply]');
    console.log(JSON.stringify(migrateDecisionContext(args[index + 1], args.includes('--apply')), null, 2));
  } catch (error: any) { console.error(error.message); process.exitCode = 1; }
}
