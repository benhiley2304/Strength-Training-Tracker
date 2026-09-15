import {randomBytes, scrypt as scryptCallback, createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt = promisify(scryptCallback);
export const SESSION_AGE = 30 * 24 * 60 * 60;
export const hash = value => createHash('sha256').update(value).digest('hex');
export const normalizeUsername = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
export const validUsername = value => /^[a-z0-9][a-z0-9_-]{2,31}$/.test(value);
export const validPassword = value => typeof value === 'string' && value.length >= 12 && value.length <= 128 && Buffer.byteLength(value) <= 512;
export function equal(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); }
export async function passwordHash(password, salt = randomBytes(24).toString('hex')) {
  const key = await scrypt(password, salt, 64, {N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024});
  return {algorithm: 'scrypt', N: 32768, r: 8, p: 1, salt, key: key.toString('hex')};
}
const dummy = {salt: 'f'.repeat(48), key: '0'.repeat(128)};
export async function checkPassword(password, record) {
  const actual = await passwordHash(password, (record || dummy).salt);
  return equal(actual.key, (record || dummy).key) && !!record;
}
export const recoveryCode = () => randomBytes(24).toString('hex').match(/.{1,8}/g).join('-');
export const recoveryHash = code => hash(code.replaceAll('-', '').toLowerCase());
export function signSession(account, secret) {
  const payload = Buffer.from(JSON.stringify({id: account.id, v: account.sessionVersion, exp: Math.floor(Date.now() / 1000) + SESSION_AGE, sid: randomBytes(24).toString('hex')})).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
export function parseSession(token, secret) {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || !equal(signature, createHmac('sha256', secret).update(payload).digest('base64url'))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!/^[a-f0-9]{64}$/.test(data.id) || !/^[a-f0-9]{48}$/.test(data.sid) || !Number.isSafeInteger(data.v) || !Number.isSafeInteger(data.exp) || data.exp <= Date.now() / 1000) return null;
    return data;
  } catch { return null; }
}
export function authorized(account, session) {
  return !!account && !!session && account.id === session.id && account.sessionVersion === session.v && !(account.revokedSessions || []).some(x => x.sid === hash(session.sid));
}
/** Memory-bounded, IP + account-key limits; buckets are not tied to account existence. */
export class RateLimiter {
  constructor({limit = 12, windowMs = 15 * 60 * 1000, maxEntries = 10000} = {}) { this.limit = limit; this.windowMs = windowMs; this.maxEntries = maxEntries; this.entries = new Map(); }
  allow(key, now = Date.now()) {
    if (this.entries.size >= this.maxEntries) {
      for (const [k, v] of this.entries) if (v.until <= now) this.entries.delete(k);
      if (!this.entries.has(key) && this.entries.size >= this.maxEntries) return false;
    }
    let bucket = this.entries.get(key);
    if (!bucket || bucket.until <= now) { bucket = {count: 0, until: now + this.windowMs}; this.entries.set(key, bucket); }
    return ++bucket.count <= this.limit;
  }
}
