import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {GitStorage} from '../server/storage.js';
import {createApp} from '../server.js';
import {signSession} from '../server/auth.js';
import {newProfile} from '../model.js';
const exec = promisify(execFile), id = 'a'.repeat(64);
const repo = 'git@github.com:example/private-tracker-data.git';
const git = (args, cwd) => exec('git', args, {cwd, env: {...process.env, GIT_CONFIG_NOSYSTEM: '1'}});
async function fixture() {
  const root = await mkdtemp('/tmp/stt-git-'), bare = `${root}/remote`, seed = `${root}/seed`;
  await git(['init', '--bare', '--initial-branch=main', bare], root);
  await git(['clone', bare, seed], root); await git(['config', 'user.name', 'Test'], seed); await git(['config', 'user.email', 'test@example.invalid'], seed);
  await writeFile(`${seed}/README.md`, 'Private test data\n'); await git(['add', '.'], seed); await git(['commit', '-m', 'Initialize'], seed); await git(['push', 'origin', 'main'], seed);
  const calls = [], control = {failPush: false, intercept: null};
  const runner = async (command, args, opts) => {
    assert.equal(command, 'git'); calls.push(args);
    assert.match(opts.env.GIT_SSH_COMMAND, /StrictHostKeyChecking=yes/); assert.match(opts.env.GIT_SSH_COMMAND, /IdentitiesOnly=yes/);
    if (args[0] === 'remote' && args[1] === 'get-url') return {stdout: repo};
    if (args[0] === 'push') { if (control.intercept) await control.intercept(); if (control.failPush) throw new Error('push denied'); }
    const actual = args[0] === 'clone' ? args.map(x => x === repo ? bare : x) : args;
    const result = await exec(command, actual, opts);
    if (args[0] === 'push' && control.losePushAck) { control.losePushAck = false; throw new Error('remote accepted push but acknowledgement was lost'); }
    return result;
  };
  const storage = new GitStorage({dir: `${root}/working`, sshDir: `${root}/ssh`, runner, env: {DATA_REPO_SSH: repo, GITHUB_DEPLOY_KEY_BASE64: Buffer.from('test only').toString('base64'), GITHUB_KNOWN_HOSTS_BASE64: Buffer.from('github.com test only').toString('base64')}});
  return {root, bare, seed, storage, calls, control};
}
test('Git adapter refreshes before transactions, persists remotely, and polling makes no commits', async () => {
  const f = await fixture();
  await f.storage.transaction(id, existing => { assert.equal(existing, null); return {account: {id, revision: 0, profile: {name: 'Alice'}}, result: 'created'}; });
  const saved = JSON.parse((await git(['show', `main:accounts/${id}.json`], f.bare)).stdout); assert.equal(saved.profile.name, 'Alice');
  const before = (await git(['rev-list', '--count', 'main'], f.bare)).stdout;
  for (let i = 0; i < 3; i++) await f.storage.transaction(id, a => ({result: a}));
  assert.equal((await git(['rev-list', '--count', 'main'], f.bare)).stdout, before);
  assert.ok(f.calls.filter(args => args[0] === 'fetch').length >= 4); assert.ok(!f.calls.flat().includes('--force'));
});
test('failed remote push is bounded, never acknowledged, and disposable local commits cannot masquerade as remote saves', async () => {
  const f = await fixture();
  await f.storage.transaction(id, () => ({account: {id, revision: 0, value: 'original'}, result: true}));
  f.control.failPush = true;
  await assert.rejects(f.storage.transaction(id, a => ({account: {...a, revision: 1, value: 'unsaved'}, result: true})), {status: 503});
  const saved = JSON.parse((await git(['show', `main:accounts/${id}.json`], f.bare)).stdout); assert.equal(saved.value, 'original');
  assert.equal(f.calls.filter(args => args[0] === 'push').length, 4);
  f.control.failPush = false;
  const a = await f.storage.transaction(id, a => ({result: a})); assert.equal(a.value, 'original');
});
test('concurrent remote update forces refresh and reruns revision validation, not a blind force-push', async () => {
  const f = await fixture();
  await f.storage.transaction(id, () => ({account: {id, revision: 0, value: 'original'}, result: true}));
  f.control.intercept = async () => {
    f.control.intercept = null;
    await git(['pull', '--ff-only'], f.seed); await writeFile(`${f.seed}/accounts/${id}.json`, JSON.stringify({id, revision: 1, value: 'other-device'}));
    await git(['add', '.'], f.seed); await git(['commit', '-m', 'Other device'], f.seed); await git(['push', 'origin', 'main'], f.seed);
  };
  let attempts = 0;
  await assert.rejects(f.storage.transaction(id, a => {
    attempts++; if (a.revision !== 0) throw Object.assign(new Error('Conflict'), {status: 409});
    return {account: {...a, revision: 1, value: 'this-device'}, result: true};
  }), {status: 409});
  assert.equal(attempts, 2);
  assert.equal(JSON.parse((await git(['show', `main:accounts/${id}.json`], f.bare)).stdout).value, 'other-device');
});
test('account paths cannot use usernames or traverse directories', async () => {
  const f = await fixture(); await assert.rejects(f.storage.transaction('../../escape', () => ({result: true})), /identity/);
  assert.throws(() => new GitStorage({env: {DATA_REPO_SSH: 'https://github.com/example/repo.git'}}));
});

test('Git-backed API recovers a lost successful push acknowledgement and stale equal PUT with no second commit', async t => {
  const f = await fixture(), env = {NODE_ENV: 'test', APP_ORIGIN: 'https://tracker.test', SESSION_SECRET: 'synthetic-session-secret-'.repeat(4), INVITE_CODE: 'synthetic-test-invite'};
  const account = {id, username: 'synthetic', sessionVersion: 1, revokedSessions: [], revision: 0, updatedAt: '2026-09-15T18:00:00Z', theme: 'light', profile: newProfile('Synthetic', id)};
  await f.storage.transaction(id, () => ({account, result: true}));
  const server = createApp({env, storage: f.storage}); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const before = Number((await git(['rev-list', '--count', 'main'], f.bare)).stdout);
  const request = () => fetch(`http://127.0.0.1:${server.address().port}/api/profile`, {method: 'PUT', headers: {'Content-Type': 'application/json', Origin: env.APP_ORIGIN, Cookie: `__Host-stt_session=${signSession(account, env.SESSION_SECRET)}`, 'If-Match': '"0"'}, body: JSON.stringify({revision: 0, theme: 'dark', profile: {...account.profile, bw: 80}})});
  f.control.losePushAck = true;
  const first = await request(); assert.equal(first.status, 200); assert.equal((await first.json()).revision, 1);
  const second = await request(); assert.equal(second.status, 200); assert.equal((await second.json()).revision, 1);
  assert.equal(Number((await git(['rev-list', '--count', 'main'], f.bare)).stdout), before + 1);
  assert.equal(f.calls.filter(args => args[0] === 'push').length, 2); // seed account + actual changed profile, never the retry.
});
