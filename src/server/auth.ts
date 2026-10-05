import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import { readValue, saveValue, transaction, appendRecord } from '../core/storage';
import { config } from '../core/config';

export type Role = 'viewer' | 'operator' | 'admin';
interface User { name: string; role: Role; salt: string; hash: string; version: string; disabled?: boolean }
interface Session { username: string; version: string; expires: number; csrf: string }
export interface Principal { name: string; role: Role; csrf?: string; sessionId?: string }
export const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => crypto.timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
export function users(): Record<string, User> { return readValue('users') ?? {}; }
const sessions = (): Record<string, Session> => readValue('sessions') ?? {};

/** Provisioned by the host administrator, never by an unauthenticated web request. */
export function setUser(name: string, role: Role, password: string): void {
  if (!/^[a-zA-Z0-9@._-]{3,100}$/.test(name)) throw new Error('Use 3–100 letters, digits, @, dot, dash, or underscore for a username');
  if (!['viewer', 'operator', 'admin'].includes(role)) throw new Error('Invalid role');
  if (password.length < 16 || password.length > 256) throw new Error('Password must be 16–256 characters');
  const salt = crypto.randomBytes(16).toString('hex');
  const user: User = { name, role, salt, hash: crypto.scryptSync(password, salt, 64).toString('hex'), version: crypto.randomUUID() };
  transaction(() => {
    saveValue('users', { ...users(), [name]: user });
    appendRecord('operator', crypto.randomUUID(), new Date().toISOString(), { action: 'provision_user', name, role, actorId: 'host-admin' });
  });
}
export function disableUser(name: string): void {
  const all = users();
  if (!all[name]) throw new Error('Unknown user');
  saveValue('users', { ...all, [name]: { ...all[name], disabled: true, version: crypto.randomUUID() } });
}
export async function login(name: string, password: string): Promise<{ token: string; csrf: string; user: Principal } | null> {
  const user = users()[name];
  const result = await new Promise<Buffer>((resolve, reject) => crypto.scrypt(password, user?.salt ?? 'unknown-user', 64, (err, key) => err ? reject(err) : resolve(key)));
  if (!user || user.disabled || !equal(result.toString('hex'), user.hash)) return null;
  // Password/role changes revoke all previous sessions, including a login racing the change.
  if (users()[name]?.version !== user.version) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  transaction(() => {
    const live = Object.fromEntries(Object.entries(sessions()).filter(([, s]) => s.expires > Date.now()));
    const own = Object.entries(live).filter(([, s]) => s.username === name);
    for (const [id] of own.slice(0, Math.max(0, own.length - 4))) delete live[id];
    saveValue('sessions', { ...live, [hash(token)]: { username: name, version: user.version, expires: Date.now() + 12 * 3600_000, csrf } });
  });
  return { token, csrf, user: { name, role: user.role } };
}
export function authenticate(req: IncomingMessage): Principal | null {
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1].trim();
  if (token && config.api.token && equal(token, config.api.token)) return { name: 'service-admin', role: 'admin' };
  if (token && config.api.viewerToken && equal(token, config.api.viewerToken)) return { name: 'service-viewer', role: 'viewer' };
  const cookie = /(?:^|;\s*)autotrade_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
  if (!cookie) return null;
  const id = hash(cookie), session = sessions()[id];
  const user = session && users()[session.username];
  if (!session || session.expires <= Date.now() || !user || user.disabled || user.version !== session.version) return null;
  return { name: user.name, role: user.role, csrf: session.csrf, sessionId: id };
}
export function logout(principal: Principal): void {
  if (!principal.sessionId) return;
  const all = sessions(); delete all[principal.sessionId]; saveValue('sessions', all);
}
export function sessionCookie(token: string): string {
  return `autotrade_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? 43200 : 0}${config.api.publicOrigin.startsWith('https://') ? '; Secure' : ''}`;
}
