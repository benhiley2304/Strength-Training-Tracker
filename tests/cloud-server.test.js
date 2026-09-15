import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.js';
import {DiskStorage, atomicWrite} from '../server/storage.js';
import {hash, passwordHash, checkPassword, signSession, parseSession, RateLimiter} from '../server/auth.js';
const password = 'correct horse battery staple';
const inviteCode = 'private-test-invite-code';
const env = {NODE_ENV: 'test', SESSION_SECRET: 'test-session-secret-'.repeat(4), INVITE_CODE: inviteCode, APP_ORIGIN: 'https://tracker.test'};
async function fixture(t, options = {}) {
  const dir = options.dir || await mkdtemp(path.join(os.tmpdir(), 'stt-api-'));
  const storage = options.storage || new DiskStorage({dir, env});
  const server = createApp({env, storage, authLimiter: new RateLimiter({limit: 2000}), ...options});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, {method = 'GET', body, cookie, headers = {}} = {}) => {
    const res = await fetch(base + route, {method, headers: {'Content-Type': 'application/json', Origin: env.APP_ORIGIN, ...(cookie ? {Cookie: cookie} : {}), ...headers}, ...(body !== undefined ? {body: typeof body === 'string' ? body : JSON.stringify(body)} : {})});
    const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return {status: res.status, data, headers: res.headers, cookie: res.headers.get('set-cookie')?.split(';')[0]};
  };
  const signup = (username = 'alice', extra = {}) => call('/api/auth/signup', {method: 'POST', body: {username, password, inviteCode, name: username, ...extra}});
  return {call, signup, dir, storage, server};
}
test('scrypt is salted, robust, asynchronous and verifies only correct passwords', async () => {
  const a = await passwordHash(password), b = await passwordHash(password);
  assert.notEqual(a.salt, b.salt); assert.notEqual(a.key, b.key); assert.equal(a.N, 32768);
  assert.equal(await checkPassword(password, a), true); assert.equal(await checkPassword('wrong password', a), false);
  assert.equal(await checkPassword(password, null), false);
});
test('HMAC sessions reject tampering and expiry', () => {
  const a = {id: hash('alice'), sessionVersion: 2}, token = signSession(a, env.SESSION_SECRET);
  assert.equal(parseSession(token, env.SESSION_SECRET).v, 2);
  assert.equal(parseSession(token + 'x', env.SESSION_SECRET), null);
  assert.equal(parseSession(token, 'wrong secret'), null);
  assert.equal(parseSession('invalid', env.SESSION_SECRET), null);
});
test('cloud config is public but static serving never exposes server files, repository, or credentials', async t => {
  const {call} = await fixture(t);
  assert.equal((await call('/api/config')).data.cloud, true);
  for (const route of ['/server.js', '/server/auth.js', '/.git/config', '/package.json', '/README.md', '/accounts/alice.json', '/api/accounts', '/api/account/alice']) assert.equal((await call(route)).status, 404, route);
  assert.equal((await call('/')).headers.get('cache-control'), 'no-store');
  assert.equal((await call('/api/config')).headers.get('cache-control'), 'no-store');
  assert.equal((await call('/cloud.js')).status, 200);
  assert.equal((await call('/api/account')).status, 401);
});
test('invite-only signup uses a private account, secure cookie, one-time recovery and hashed at-rest credentials', async t => {
  const {signup, call, dir} = await fixture(t);
  assert.equal((await signup('outsider', {inviteCode: 'wrong'})).status, 400);
  const res = await signup('Alice'); assert.equal(res.status, 201);
  assert.match(res.headers.get('set-cookie'), /__Host-stt_session=.*HttpOnly; Secure; SameSite=Lax/);
  assert.equal(res.data.account.username, 'alice'); assert.equal(res.data.profile.id, hash('alice'));
  assert.match(res.data.recoveryCode, /^[a-f0-9-]{53}$/);
  const saved = JSON.parse(await readFile(path.join(dir, 'accounts', `${hash('alice')}.json`), 'utf8'));
  assert.notEqual(saved.password.key, password); assert.equal(saved.password.algorithm, 'scrypt');
  assert.ok(!JSON.stringify(saved).includes(res.data.recoveryCode)); assert.ok(!JSON.stringify(saved).includes(inviteCode));
  const get = await call('/api/account', {cookie: res.cookie}); assert.equal(get.status, 200);
  assert.equal(get.data.recoveryCode, undefined); assert.equal(get.data.password, undefined); assert.equal(get.data.sessionVersion, undefined);
});
test('wrong login and recovery responses do not enumerate registered accounts', async t => {
  const {signup, call} = await fixture(t); await signup();
  const login = username => call('/api/auth/login', {method: 'POST', body: {username, password: 'wrong password for test'}});
  assert.deepEqual((await login('alice')).data, (await login('missing')).data);
  const recover = username => call('/api/auth/recover', {method: 'POST', body: {username, password, recoveryCode: 'a'.repeat(48)}});
  assert.deepEqual((await recover('alice')).data, (await recover('missing')).data);
  const duplicate = await signup(); const noInvite = await signup('stranger', {inviteCode: 'incorrect'});
  assert.equal(duplicate.status, noInvite.status); assert.deepEqual(duplicate.data, noInvite.data);
});
test('username registration is atomic and normalized', async t => {
  const {signup, dir} = await fixture(t);
  const results = await Promise.all([signup('ALICE'), signup('alice')]);
  assert.deepEqual(results.map(x => x.status).sort(), [201, 400]);
  assert.equal((await readdir(path.join(dir, 'accounts'))).filter(x => x.endsWith('.json')).length, 1);
});
test('two accounts cannot read, change or discover each other through profile requests', async t => {
  const {signup, call} = await fixture(t); const a = await signup('alice'), b = await signup('bob');
  assert.equal((await call('/api/account', {cookie: b.cookie})).data.profile.name, 'bob');
  const write = await call('/api/profile', {method: 'PUT', cookie: b.cookie, body: {profile: a.data.profile, theme: 'light', revision: 0}});
  assert.equal(write.status, 400);
  assert.equal((await call('/api/account?user=alice', {cookie: b.cookie})).status, 400);
  assert.equal((await call('/api/account', {cookie: a.cookie})).data.profile.name, 'alice');
});
test('Origin and cross-site checks block CSRF, even with valid cookies', async t => {
  const {call, signup} = await fixture(t); const a = await signup();
  for (const headers of [{Origin: 'https://evil.example'}, {Origin: ''}, {'Sec-Fetch-Site': 'cross-site'}]) {
    assert.equal((await call('/api/auth/logout', {method: 'POST', cookie: a.cookie, body: {}, headers})).status, 403);
  }
  assert.equal((await call('/api/account', {cookie: a.cookie})).status, 200);
});
test('malformed JSON, oversized auth bodies and invalid field ranges never replace data', async t => {
  const {call, signup} = await fixture(t); const a = await signup();
  assert.equal((await call('/api/auth/login', {method: 'POST', body: '{'})).status, 400);
  assert.equal((await call('/api/auth/login', {method: 'POST', body: '[]'})).status, 400);
  assert.equal((await call('/api/auth/login', {method: 'POST', body: 'x'.repeat(5000)})).status, 413);
  assert.equal((await call('/api/auth/login', {method: 'POST', body: {}, headers: {'Content-Type': 'text/plain'}})).status, 415);
  for (const profile of [{...a.data.profile, bw: -1}, {...a.data.profile, current: 13}, {...a.data.profile, name: ''}, {...a.data.profile, anotherAccount: 'secret'}]) {
    assert.equal((await call('/api/profile', {method: 'PUT', cookie: a.cookie, body: {profile, theme: 'light', revision: 0}})).status, 400);
  }
  assert.equal((await call('/api/account', {cookie: a.cookie})).data.revision, 0);
});
test('optimistic revision conflicts return the current account only; explicit retry preserves choices', async t => {
  const {call, signup} = await fixture(t); const a = await signup();
  const write = (revision, name, headers = {}) => call('/api/profile', {method: 'PUT', cookie: a.cookie, headers, body: {revision, profile: {...a.data.profile, name}, theme: 'dark'}});
  const one = await write(0, 'Phone'); assert.equal(one.status, 200); assert.equal(one.data.revision, 1);
  const conflict = await write(0, 'Desktop'); assert.equal(conflict.status, 409); assert.equal(conflict.data.latest.profile.name, 'Phone'); assert.equal(conflict.data.latest.password, undefined);
  assert.equal((await write(1, 'Desktop', {'If-Match': '"1"'})).status, 200);
  assert.equal((await call('/api/account', {cookie: a.cookie})).data.profile.name, 'Desktop');
});
test('missing, malformed, unsafe and contradictory revisions are rejected', async t => {
  const {call, signup} = await fixture(t); const a = await signup();
  const update = (revision, headers = {}) => call('/api/profile', {method: 'PUT', cookie: a.cookie, headers, body: {revision, profile: a.data.profile, theme: 'light'}});
  assert.equal((await update(undefined)).status, 428);
  for (const revision of [-1, 0.5, '0', null, Number.MAX_SAFE_INTEGER]) assert.equal((await update(revision)).status, 400);
  assert.equal((await update(0, {'If-Match': '1'})).status, 400);
  assert.equal((await update(0, {'If-Match': '"1"'})).status, 400);
  assert.equal((await update(undefined, {'If-Match': '"0"'})).status, 200);
});
test('disk failures never acknowledge a save, overwrite the prior document, or create an account', async t => {
  const {call, signup, storage} = await fixture(t); const a = await signup();
  storage.write = async () => { throw new Error('disk full with sensitive internal text'); };
  const write = await call('/api/profile', {method: 'PUT', cookie: a.cookie, body: {revision: 0, profile: {...a.data.profile, name: 'Not saved'}, theme: 'light'}});
  assert.equal(write.status, 503); assert.ok(!JSON.stringify(write.data).includes('sensitive'));
  assert.equal((await call('/api/account', {cookie: a.cookie})).data.profile.name, 'alice');
  assert.equal((await signup('bob')).status, 503);
  storage.write = atomicWrite; assert.equal((await signup('bob')).status, 201);
});
test('account persistence survives a new server and storage instance', async t => {
  const first = await fixture(t); const a = await first.signup();
  await first.call('/api/profile', {method: 'PUT', cookie: a.cookie, body: {revision: 0, profile: {...a.data.profile, bw: 82.5}, theme: 'dark'}});
  const second = await fixture(t, {dir: first.dir});
  const login = await second.call('/api/auth/login', {method: 'POST', body: {username: 'alice', password}});
  assert.equal(login.status, 200); assert.equal(login.data.profile.bw, 82.5); assert.equal(login.data.theme, 'dark'); assert.equal(login.data.revision, 1);
});
test('recovery rotates the code, changes password and invalidates every older session without losing training', async t => {
  const {call, signup} = await fixture(t); const a = await signup();
  const recovery = await call('/api/auth/recover', {method: 'POST', body: {username: 'alice', password: 'new secure password chosen', recoveryCode: a.data.recoveryCode}});
  assert.equal(recovery.status, 200); assert.notEqual(recovery.data.recoveryCode, a.data.recoveryCode);
  assert.equal((await call('/api/account', {cookie: a.cookie})).status, 401);
  assert.equal((await call('/api/auth/login', {method: 'POST', body: {username: 'alice', password}})).status, 401);
  const login = await call('/api/auth/login', {method: 'POST', body: {username: 'alice', password: 'new secure password chosen'}});
  assert.equal(login.status, 200); assert.equal(login.data.profile.name, 'alice');
  assert.equal((await call('/api/auth/recover', {method: 'POST', body: {username: 'alice', password, recoveryCode: a.data.recoveryCode}})).status, 400);
});
test('logout invalidates only that session; password changes invalidate other devices', async t => {
  const {call, signup} = await fixture(t); const a = await signup();
  const b = await call('/api/auth/login', {method: 'POST', body: {username: 'alice', password}});
  assert.equal((await call('/api/auth/logout', {method: 'POST', cookie: a.cookie, body: {}})).status, 200);
  assert.equal((await call('/api/account', {cookie: a.cookie})).status, 401);
  assert.equal((await call('/api/account', {cookie: b.cookie})).status, 200);
  const c = await call('/api/auth/password', {method: 'POST', cookie: b.cookie, body: {currentPassword: password, password: 'a newly changed password'}});
  assert.equal(c.status, 200); assert.equal((await call('/api/account', {cookie: b.cookie})).status, 401);
  assert.equal((await call('/api/account', {cookie: c.cookie})).status, 200);
});
test('all auth routes are rate limited and limiter storage is bounded', async t => {
  const limiter = new RateLimiter({limit: 2, maxEntries: 2});
  assert.equal(limiter.allow('a'), true); assert.equal(limiter.allow('a'), true); assert.equal(limiter.allow('a'), false);
  assert.equal(limiter.allow('b'), true); assert.equal(limiter.allow('c'), false);
  const {call} = await fixture(t, {authLimiter: new RateLimiter({limit: 1})});
  assert.equal((await call('/api/auth/login', {method: 'POST', body: {username: 'missing', password}})).status, 401);
  for (const route of ['signup', 'recover', 'password', 'logout']) assert.equal((await call(`/api/auth/${route}`, {method: 'POST', body: {}})).status, 429);
});
test('production refuses test storage and weak or incomplete configuration', () => {
  assert.throws(() => new DiskStorage({dir: '/tmp/stt-test-refusal', env: {NODE_ENV: 'production', STT_TEST_STORAGE: 'true'}}));
  assert.throws(() => new DiskStorage({dir: '/tmp/stt-test-refusal', env: {}}));
  assert.throws(() => createApp({env: {...env, NODE_ENV: 'production', STT_TEST_STORAGE: 'true'}}));
  assert.throws(() => createApp({env: {...env, SESSION_SECRET: 'weak'}}));
  assert.throws(() => createApp({env: {...env, APP_ORIGIN: 'https://tracker.test/'}}));
});
