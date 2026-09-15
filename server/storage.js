import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {mkdir, readFile, writeFile, rename, chmod, open, lstat} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
const exec = promisify(execFile);
let queue = Promise.resolve();
/** One process-wide lock covers reads and writes, including all git operations. */
export function serialized(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}
export class StorageError extends Error {
  constructor() { super('Cloud storage is temporarily unavailable. Your changes have not been confirmed saved. Please retry.'); this.status = 503; }
}
export async function atomicWrite(filename, value) {
  const temp = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(temp, filename);
}
function accountPath(dir, id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid account identity');
  return path.join(dir, 'accounts', `${id}.json`);
}
async function readAccount(dir, id) {
  const filename = accountPath(dir, id);
  try {
    if (!(await lstat(filename)).isFile() || (await lstat(filename)).isSymbolicLink()) throw new Error('Unsafe account file');
    return JSON.parse(await readFile(filename, 'utf8'));
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export class DiskStorage {
  constructor({dir, env = process.env, write = atomicWrite} = {}) {
    if (env.NODE_ENV === 'production' || !(env.NODE_ENV === 'test' || env.STT_TEST_STORAGE === 'true')) throw new Error('Disk storage is test-only and forbidden in production');
    if (!dir) throw new Error('Test storage directory required');
    this.dir = dir; this.write = write;
  }
  async transaction(id, fn) {
    return serialized(async () => {
      try {
        await mkdir(path.join(this.dir, 'accounts'), {recursive: true, mode: 0o700});
        const result = await fn(await readAccount(this.dir, id));
        if (result.account) await this.write(accountPath(this.dir, id), result.account);
        return result.result;
      } catch (e) { if (e.status) throw e; throw new StorageError(); }
    });
  }
}
export class GitStorage {
  constructor({env = process.env, dir = '/tmp/stt-data', sshDir = '/tmp/stt-ssh', runner = exec} = {}) {
    this.dir = dir; this.sshDir = sshDir; this.env = env; this.runner = runner;
    this.repo = env.DATA_REPO_SSH;
    this.branch = env.DATA_REPO_BRANCH || 'main';
    if (!/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(this.repo || '') || !/^[A-Za-z0-9_-]+$/.test(this.branch)) throw new Error('A GitHub SSH data repository and safe branch are required');
    if (!env.GITHUB_DEPLOY_KEY_BASE64 || !env.GITHUB_KNOWN_HOSTS_BASE64) throw new Error('Private deploy key and pinned known hosts are required');
    if (![dir, sshDir].every(x => /^\/[A-Za-z0-9/_-]+$/.test(x))) throw new Error('Unsafe storage directory');
    this.ready = false;
  }
  async git(args, clone = false) {
    return this.runner('git', args, {cwd: clone ? '/tmp' : this.dir, timeout: 45000, maxBuffer: 1024 * 1024,
      env: {...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
        GIT_SSH_COMMAND: `ssh -F /dev/null -i ${this.sshDir}/deploy_key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${this.sshDir}/known_hosts -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=15`}});
  }
  async refresh() {
    if (!this.ready) {
      await mkdir(this.sshDir, {recursive: true, mode: 0o700}); await chmod(this.sshDir, 0o700);
      await writeFile(`${this.sshDir}/deploy_key`, Buffer.from(this.env.GITHUB_DEPLOY_KEY_BASE64, 'base64'), {mode: 0o600});
      await chmod(`${this.sshDir}/deploy_key`, 0o600);
      await writeFile(`${this.sshDir}/known_hosts`, Buffer.from(this.env.GITHUB_KNOWN_HOSTS_BASE64, 'base64'), {mode: 0o600});
      try { await lstat(path.join(this.dir, '.git')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; await this.git(['clone', '--branch', this.branch, '--single-branch', this.repo, this.dir], true); }
      const remote = await this.git(['remote', 'get-url', 'origin']);
      if (remote.stdout.trim() !== this.repo) throw new Error('Unexpected data repository');
      await this.git(['config', 'user.name', 'Strength Tracker']);
      await this.git(['config', 'user.email', 'tracker@users.noreply.github.com']);
      this.ready = true;
    }
    await this.git(['fetch', '--no-tags', 'origin', this.branch]);
    // A failed push is never treated as durable. Reset the disposable working copy before every transaction.
    await this.git(['reset', '--hard', `origin/${this.branch}`]);
    await this.git(['clean', '-fd', '--', 'accounts/']);
    await mkdir(path.join(this.dir, 'accounts'), {recursive: true, mode: 0o700});
  }
  async transaction(id, fn) {
    accountPath(this.dir, id);
    return serialized(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.refresh();
          const result = await fn(await readAccount(this.dir, id));
          if (!result.account) return result.result; // Reading/polling never creates commits.
          await atomicWrite(accountPath(this.dir, id), result.account);
          await this.git(['add', '--', `accounts/${id}.json`]);
          await this.git(['commit', '-m', 'Update account document']);
          try { await this.git(['push', 'origin', `HEAD:refs/heads/${this.branch}`]); return result.result; }
          catch { if (attempt === 2) throw new StorageError(); /* Refresh + rerun optimistic checks; never force-push. */ }
        } catch (e) { if (e.status) throw e; throw new StorageError(); }
      }
      throw new StorageError();
    });
  }
}
