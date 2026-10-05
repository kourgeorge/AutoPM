import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './paths';
export function newJobDirectory(kind: string): string {
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(6).toString('hex');
  const dir = path.join(DATA_DIR, 'jobs', kind + '-' + id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id, kind, createdAt: new Date().toISOString() }));
  return dir;
}
