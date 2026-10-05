import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DATA_DIR } from '../core/paths';
import { database, closeStorage } from '../core/storage';

// VACUUM INTO takes a consistent SQLite snapshot, including committed WAL records.
// Restoration is deliberately into a NEW data directory; never overwrite a running account.
const [command = 'create', source, destination] = process.argv.slice(2);
try {
  if (command === 'create') {
    const dir = path.join(DATA_DIR, 'backups'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex') + '.sqlite');
    database().prepare('VACUUM INTO ?').run(file); fs.chmodSync(file, 0o600);
    process.stdout.write(file + '\n');
  } else if (command === 'restore' && source && destination) {
    if (fs.existsSync(destination)) throw new Error('Restore destination must be a new directory');
    const { DatabaseSync } = require('node:sqlite');
    const backup = new DatabaseSync(path.resolve(source), { readOnly: true });
    try {
      if (backup.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup integrity check failed');
      const state = JSON.parse(backup.prepare("SELECT value FROM settings WHERE key='state'").get()?.value ?? '{}');
      if (state.schemaVersion !== 1 || !state.accountId) throw new Error('Backup has no supported account identity');
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      const target = path.join(destination, 'autotrade.sqlite');
      // Copy from the validated snapshot using SQLite rather than copying possible WAL files.
      backup.prepare('VACUUM INTO ?').run(path.resolve(target)); fs.chmodSync(target, 0o600);
      const restored = new DatabaseSync(path.resolve(target));
      restored.prepare("UPDATE settings SET value='null' WHERE key='workerLease'").run();
      const paused = { ...state, paused: true };
      restored.prepare("UPDATE settings SET value=? WHERE key='state'").run(JSON.stringify(paused));
      restored.prepare("DELETE FROM settings WHERE key='sessions'").run();
      restored.close();
      process.stdout.write(`Restored ${state.accountId} in paused mode. Stop the original worker before starting this copy.\n`);
    } finally { backup.close(); }
  } else throw new Error('Usage: npm run backup -- create | restore BACKUP.sqlite NEW_DATA_DIR');
} catch (err: any) { process.stderr.write(err.message + '\n'); process.exitCode = 1; }
finally { closeStorage(); }
