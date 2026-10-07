import fs from 'fs';
import crypto from 'crypto';
import { getState } from '../state/state';
import { recordFills } from '../review/fills';
import { transaction, appendRecord, closeStorage } from '../core/storage';
import type { Fill } from '../broker/IBroker';

try {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: npm run import:fills -- ACCOUNT_FILLS.json');
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!input.accountId || input.accountId !== getState().accountId) throw new Error('Fill import must match the bound accountId, including broker and venue');
  if (!Array.isArray(input.fills) || input.fills.length > 100000) throw new Error('Expected at most 100000 fills');
  for (const f of input.fills) {
    if (!f.execId || !f.orderId || !f.symbol || !['buy','sell'].includes(f.side) || !Number.isFinite(f.qty) || f.qty <= 0 || !Number.isFinite(f.price) || f.price <= 0 || !Number.isFinite(Date.parse(f.at)) || !(f.fee === null || Number.isFinite(f.fee))) throw new Error('Malformed fill: ' + String(f.execId));
  }
  const count = transaction(() => {
    const added = recordFills(input.fills as Fill[]);
    appendRecord('operator-commands', crypto.randomUUID(), new Date().toISOString(), { action: 'import_fills', actorId: 'host-admin', count: added, sourceHash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
    return added;
  });
  process.stdout.write(`Imported ${count} new or corrected fills for ${input.accountId}.\n`);
} catch (err: any) { process.stderr.write(err.message + '\n'); process.exitCode = 1; }
finally { closeStorage(); }
