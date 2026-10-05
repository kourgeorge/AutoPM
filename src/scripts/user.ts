import crypto from 'crypto';
import { setUser, disableUser, type Role } from '../server/auth';
import { closeStorage } from '../core/storage';

const [name, role] = process.argv.slice(2);
try {
  if (!name || !role) throw new Error('Usage: npm run user -- USERNAME admin|operator|viewer|disable');
  if (role === 'disable') disableUser(name);
  else {
    const password = process.env.AUTOTRADE_USER_PASSWORD ?? crypto.randomBytes(24).toString('base64url');
    setUser(name, role as Role, password);
    if (!process.env.AUTOTRADE_USER_PASSWORD) process.stdout.write(`Generated password (store securely): ${password}\n`);
  }
  process.stdout.write('User saved. Previous sessions revoked.\n');
} catch (err: any) { process.stderr.write(err.message + '\n'); process.exitCode = 1; }
finally { closeStorage(); }
