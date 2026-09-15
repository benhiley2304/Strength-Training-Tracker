import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {GitStorage, DiskStorage} from './server/storage.js';
import {hash, normalizeUsername, validUsername, validPassword, passwordHash, checkPassword, equal, recoveryCode, recoveryHash, signSession, parseSession, authorized, RateLimiter, SESSION_AGE} from './server/auth.js';
import {APP, newProfile, validateState} from './model.js';
const root = path.dirname(fileURLToPath(import.meta.url));
const AUTH_ERROR = 'Unable to complete this request. Check your details and try again.';
export class ApiError extends Error {
  constructor(status, message, data = {}) { super(message); this.status = status; this.data = data; }
}
const fail = (status, message, data) => { throw new ApiError(status, message, data); };
const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const only = (x, keys) => isObject(x) && Object.keys(x).every(k => keys.includes(k));
const view = a => ({account: {id: a.id, username: a.username}, revision: a.revision, updatedAt: a.updatedAt, profile: a.profile, theme: a.theme});
function validateProfile(profile, id, theme) {
  if (!only(profile, ['id', 'name', 'bw', 'current', 'cycle', 'completed', 'drafts', 'history', 'restSeconds', 'legacy']) || profile.id !== id) fail(400, 'Invalid profile document.');
  try { return validateState({app: APP, version: 3, revision: 0, activeProfileId: id, theme, profiles: [profile]}).profiles[0]; }
  catch { fail(400, 'Invalid profile document. Check field ranges and workout structure.'); }
}
async function body(req, max) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) fail(415, 'Send a JSON document.');
  if (Number(req.headers['content-length']) > max) fail(413, 'Request exceeds the size limit.');
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > max) fail(413, 'Request exceeds the size limit.'); chunks.push(chunk); }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isObject(data)) fail(400, 'Invalid JSON document.');
    return data;
  } catch { fail(400, 'Invalid JSON document.'); }
}
const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ...['app.js', 'cloud.js', 'cloud-config.js', 'model.js', 'programme.js', 'icons.js', 'sw.js'].map(x => [`/${x}`, [x, 'text/javascript']]),
  ['/styles.css', ['styles.css', 'text/css']], ['/manrope-latin.woff2', ['manrope-latin.woff2', 'font/woff2']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ...['icon.svg', 'icon-maskable.svg'].map(x => [`/${x}`, [x, 'image/svg+xml']])
]);
export function createApp({env = process.env, storage, authLimiter = new RateLimiter(), readLimiter = new RateLimiter({limit: 180, windowMs: 60000})} = {}) {
  if (env.NODE_ENV === 'production' && env.STT_TEST_STORAGE === 'true') throw new Error('Test storage is forbidden in production');
  if (!env.SESSION_SECRET || Buffer.byteLength(env.SESSION_SECRET) < 32) throw new Error('SESSION_SECRET must be at least 32 bytes');
  if (!env.INVITE_CODE || env.INVITE_CODE.length < 12) throw new Error('INVITE_CODE must be at least 12 characters');
  let origin;
  try { origin = new URL(env.APP_ORIGIN).origin; if (origin !== env.APP_ORIGIN || (env.NODE_ENV === 'production' && !origin.startsWith('https://'))) throw new Error(); }
  catch { throw new Error('APP_ORIGIN must be the exact app origin (HTTPS in production, no trailing slash)'); }
  storage ||= env.NODE_ENV === 'test' || env.STT_TEST_STORAGE === 'true' ? new DiskStorage({dir: env.STT_TEST_DIR || '/tmp/stt-test-data', env}) : new GitStorage({env});
  const cookieName = '__Host-stt_session';
  const cookie = token => `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${token ? SESSION_AGE : 0}`;
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const json = (status, value) => { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, origin), route = url.pathname;
      if (!route.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method) || !assets.has(route)) { res.writeHead(404, {'Cache-Control': 'no-store'}); res.end('Not found'); return; }
        const [file, type] = assets.get(route);
        res.setHeader('Cache-Control', ['index.html', 'sw.js', 'cloud-config.js'].includes(file) ? 'no-store' : 'public, max-age=0, must-revalidate');
        res.setHeader('Content-Type', `${type}${type.startsWith('text/') ? '; charset=utf-8' : ''}`);
        const data = await readFile(path.join(root, file)); res.end(req.method === 'HEAD' ? undefined : data); return;
      }
      res.setHeader('Cache-Control', 'no-store');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== origin) fail(403, 'This request must come from this app.');
      if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'This request must come from this app.');
      if (url.search) fail(400, 'Query parameters are not supported.');
      // Render's proxy appends the actual client to X-Forwarded-For. Never trust its first, user-supplied entry.
      const ip = env.TRUST_PROXY === 'true' ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').at(-1).trim() : req.socket.remoteAddress;
      if (!readLimiter.allow(`ip:${ip}`)) { res.setHeader('Retry-After', '60'); fail(429, 'Too many requests. Please wait and try again.'); }
      if (route === '/api/config' && req.method === 'GET') { json(200, {cloud: true, signup: 'invite-only', auth: 'username-password', storage: 'private-github', sessionDays: 30}); return; }
      const authPath = route.startsWith('/api/auth/');
      if (authPath && !authLimiter.allow(`ip:${ip}`)) { res.setHeader('Retry-After', '900'); fail(429, 'Too many account requests. Please wait and try again.'); }
      const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      const session = parseSession(token, env.SESSION_SECRET);
      const signedIn = async fn => {
        if (!session) fail(401, 'Sign in to access your account.');
        return storage.transaction(session.id, async a => { if (!authorized(a, session)) fail(401, 'Sign in to access your account.'); return fn(a); });
      };
      if (route === '/api/account' && req.method === 'GET') { json(200, await signedIn(a => ({result: view(a)}))); return; }
      if (req.method === 'POST' && ['/api/auth/signup', '/api/auth/login', '/api/auth/recover'].includes(route)) {
        const data = await body(req, 4096), username = normalizeUsername(data.username);
        if (!authLimiter.allow(`user:${hash(username)}`)) { res.setHeader('Retry-After', '900'); fail(429, 'Too many account requests. Please wait and try again.'); }
        if (!validUsername(username) || !validPassword(data.password)) fail(route.endsWith('/login') ? 401 : 400, AUTH_ERROR);
        const id = hash(username);
        if (route.endsWith('/signup')) {
          if (!only(data, ['username', 'password', 'inviteCode', 'name']) || typeof data.inviteCode !== 'string' || data.inviteCode.length > 256 || typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 40) fail(400, AUTH_ERROR);
          const password = await passwordHash(data.password), recovery = recoveryCode();
          const a = await storage.transaction(id, existing => {
            if (!equal(hash(data.inviteCode), hash(env.INVITE_CODE)) || existing) fail(400, AUTH_ERROR);
            const account = {id, username, password, recoveryHash: recoveryHash(recovery), sessionVersion: 1, revokedSessions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 0, theme: 'light', profile: newProfile(data.name.trim(), id)};
            return {account, result: account};
          });
          res.setHeader('Set-Cookie', cookie(signSession(a, env.SESSION_SECRET)));
          json(201, {...view(a), recoveryCode: recovery}); return;
        }
        if (route.endsWith('/login')) {
          if (!only(data, ['username', 'password'])) fail(401, AUTH_ERROR);
          const a = await storage.transaction(id, async account => {
            if (!await checkPassword(data.password, account?.password)) fail(401, AUTH_ERROR);
            return {result: account};
          });
          res.setHeader('Set-Cookie', cookie(signSession(a, env.SESSION_SECRET))); json(200, view(a)); return;
        }
        if (!only(data, ['username', 'password', 'recoveryCode']) || typeof data.recoveryCode !== 'string' || !/^[a-fA-F0-9-]{48,64}$/.test(data.recoveryCode)) fail(400, AUTH_ERROR);
        const password = await passwordHash(data.password), recovery = recoveryCode();
        await storage.transaction(id, account => {
          if (!account || !equal(recoveryHash(data.recoveryCode), account.recoveryHash)) fail(400, AUTH_ERROR);
          account.password = password; account.recoveryHash = recoveryHash(recovery); account.sessionVersion++; account.revokedSessions = [];
          return {account, result: null};
        });
        res.setHeader('Set-Cookie', cookie('')); json(200, {ok: true, recoveryCode: recovery}); return;
      }
      if (route === '/api/auth/logout' && req.method === 'POST') {
        await body(req, 4096);
        if (session) await signedIn(a => { a.revokedSessions = (a.revokedSessions || []).filter(x => x.exp > Date.now() / 1000); a.revokedSessions.push({sid: hash(session.sid), exp: session.exp}); return {account: a, result: null}; });
        res.setHeader('Set-Cookie', cookie('')); json(200, {ok: true}); return;
      }
      if (route === '/api/auth/password' && req.method === 'POST') {
        const data = await body(req, 4096);
        if (!only(data, ['currentPassword', 'password']) || !validPassword(data.password) || !validPassword(data.currentPassword)) fail(400, AUTH_ERROR);
        const a = await signedIn(async account => {
          if (!await checkPassword(data.currentPassword, account.password)) fail(400, AUTH_ERROR);
          account.password = await passwordHash(data.password); account.sessionVersion++; account.revokedSessions = [];
          return {account, result: account};
        });
        res.setHeader('Set-Cookie', cookie(signSession(a, env.SESSION_SECRET))); json(200, {ok: true}); return;
      }
      if (route === '/api/profile' && req.method === 'PUT') {
        if (!session) fail(401, 'Sign in to access your account.');
        const data = await body(req, 20 * 1024 * 1024);
        if (!only(data, ['revision', 'profile', 'theme'])) fail(400, 'Invalid profile document.');
        const match = req.headers['if-match'];
        if (match && !/^"\d+"$/.test(match)) fail(400, 'Invalid revision.');
        const revision = match ? Number(match.slice(1, -1)) : data.revision;
        if (revision === undefined) fail(428, 'A revision is required.');
        if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER || (match && data.revision !== undefined && data.revision !== revision)) fail(400, 'Invalid revision.');
        const profile = validateProfile(data.profile, session.id, data.theme);
        const result = await signedIn(a => {
          if (a.revision !== revision) fail(409, 'Another device changed this account. Choose which version to keep.', {latest: view(a)});
          a.profile = profile; a.theme = data.theme; a.revision++; a.updatedAt = new Date().toISOString();
          return {account: a, result: view(a)};
        });
        res.setHeader('ETag', `"${result.revision}"`); json(200, result); return;
      }
      fail(404, 'Not found.');
    } catch (error) {
      // Do not log request bodies, cookies, usernames, passwords, recovery codes, keys, or git stderr.
      json(error.status || 503, {error: error.status ? error.message : 'The service is temporarily unavailable. Please retry.', ...(error.data || {})});
    }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = createApp(); server.requestTimeout = 120000; server.headersTimeout = 15000;
    server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Strength Tracker server ready.'));
  } catch { console.error('Server configuration is invalid. Check the required deployment environment variables.'); process.exitCode = 1; }
}
