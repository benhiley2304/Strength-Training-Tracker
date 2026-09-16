import {APP, KEY, clone, validateState} from './model.js';
import {accountState, sameState, reconcile, ReconcileError} from './sync-merge.js';
export const CLOUD_MARKER = 'strengthTrackerCloudHostV1';
export const cacheKey = id => `strengthTrackerCloudCacheV1:${id}`;
export const recoveryKey = id => `${cacheKey(id)}:recovery`;
const active = () => globalThis.navigator?.onLine !== false && globalThis.document?.visibilityState !== 'hidden';
const transient = e => e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function api(path, options = {}) {
  let response;
  try { response = await fetch(path, {credentials: 'same-origin', cache: 'no-store', ...options, signal: options.signal || AbortSignal.timeout(90000), headers: {'Content-Type': 'application/json', 'X-Tracker-Features': 'exercise-substitutions-v1', ...options.headers}}); }
  catch { throw Object.assign(new Error(globalThis.navigator?.onLine === false ? 'Offline · changes are kept on this device. Reconnect to sync.' : 'Reconnecting… Your changes are kept on this device.'), {status: 0}); }
  if (!response.headers.get('content-type')?.includes('application/json')) throw Object.assign(new Error('Reconnecting… Waiting for the service to wake up.'), {status: response.status >= 500 ? response.status : 0});
  let data;
  try { data = await response.json(); } catch { throw Object.assign(new Error('Reconnecting… Waiting for a complete response.'), {status: 0}); }
  if (!response.ok) throw Object.assign(new Error(data.error || 'Request failed. Please try again.'), {status: response.status, latest: data.latest});
  return data;
}
export async function detectCloud({wait = delay} = {}) {
  try { if (localStorage.getItem(CLOUD_MARKER) === 'true') return 'cloud'; } catch { /* Optional host hint, never authentication. */ }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch('/api/config', {cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(90000)});
      const json = response.headers.get('content-type')?.includes('application/json');
      if (response.ok && json && (await response.json()).cloud === true) {
        try { localStorage.setItem(CLOUD_MARKER, 'true'); } catch { /* Storage may be blocked. */ }
        return 'cloud';
      }
      // A confirmed static host can legitimately serve a 404 or public index rewrite.
      if (response.status === 404 || (response.ok && !json)) return 'local';
      if (response.status < 500 && response.status !== 429) return 'unavailable';
    } catch { /* Startup/network failures are retried, not a cloud-to-local downgrade. */ }
    if (!active() || attempt === 2) break;
    await wait(1000 * 2 ** attempt);
  }
  try { if (localStorage.getItem(KEY)) return 'local'; } catch { /* Unknown offline host. */ }
  return 'unavailable';
}
export function documentState(data) {
  if (!data?.account || data.profile?.id !== data.account.id) throw new Error('Invalid account response.');
  return validateState({app: APP, version: 3, revision: data.revision, theme: data.theme, activeProfileId: data.account.id, profiles: [data.profile]});
}
export class CloudStore {
  constructor({onState, onStatus, onConflict, onAuthLost, storage = {getItem: key => globalThis.localStorage.getItem(key), setItem: (key, value) => globalThis.localStorage.setItem(key, value), removeItem: key => globalThis.localStorage.removeItem(key)}, request = api, wait = delay} = {}) {
    Object.assign(this, {onState, onStatus, onConflict, onAuthLost, storage, request, wait});
    this.account = null; this.state = null; this.baseState = null; this.raw = null;
    this.dirty = false; this.failed = false; this.locked = false; this.conflict = null; this.timer = null; this.inflight = null; this.refreshing = false; this.generation = 0; this.edits = 0; this.sessionExpired = false; this.retryCount = 0; this.replacement = false;
  }
  emit() { this.onState?.(clone(this.state)); } // UI may mutate its copy before calling save().
  status(message) { this.message = message; this.onStatus?.(message); }
  problem(message) { this.failed = true; this.status(message); }
  snapshot() { return {account: this.account, state: this.state, baseState: this.baseState, revision: this.revision, updatedAt: this.updatedAt, localUpdatedAt: this.localUpdatedAt, dirty: this.dirty, replacement: this.replacement}; }
  journal(reason, ...snapshots) {
    const key = recoveryKey(this.account.id), previous = this.storage.getItem(key);
    let entries = [];
    if (previous) { try { entries = JSON.parse(previous); if (!Array.isArray(entries)) throw new Error(); } catch { throw new ReconcileError('Device recovery cannot be read. Export it before continuing.'); } }
    this.storage.setItem(key, JSON.stringify([...entries.slice(-4), {at: new Date().toISOString(), reason, snapshots}]));
  }
  recovery() { return {previousRaw: this.raw, currentTab: clone(this.state), journal: this.storage.getItem(recoveryKey(this.account.id))}; }
  block(error, document) {
    this.locked = true; this.failed = true; this.conflict = document || null;
    this.status(`Review needed · ${error.message}`); if (document) this.onConflict?.(document);
  }
  readCache(raw) {
    const cache = JSON.parse(raw);
    if (!cache || cache.account?.id !== this.account.id || !Number.isSafeInteger(cache.revision) || cache.revision < 0 || typeof cache.dirty !== 'boolean') throw new ReconcileError('The device snapshot could not be read. Export recovery data before replacing it.');
    cache.state = accountState(cache.state, this.account.id);
    if (cache.baseState) cache.baseState = accountState(cache.baseState, this.account.id);
    return cache;
  }
  // localStorage read/merge/write runs synchronously. Storage events re-read the current
  // value (not potentially stale event.newValue); no tab can blindly replace another tab.
  mergeCache() {
    const raw = this.storage.getItem(cacheKey(this.account.id));
    if (raw === this.raw) return false;
    if (!raw) throw new ReconcileError('This account was cleared in another tab. Sign in again before syncing.');
    const other = this.readCache(raw);
    try { this.journal('other-tab', this.snapshot(), other); }
    catch { throw new ReconcileError('Device recovery could not be saved. Export before combining tabs.'); }
    if ((this.replacement || other.replacement) && !sameState(this.state, other.state)) throw new ReconcileError('An import is pending in another tab. Review before replacing it.');
    const merged = other.revision < this.revision
      ? (other.dirty ? reconcile(other.baseState || null, other.state, this.state, {legacyBaseUpdatedAt: other.updatedAt}) : clone(this.state))
      : reconcile(this.baseState, this.state, other.state, {sameRevision: other.revision === this.revision, legacyBaseUpdatedAt: this.updatedAt});
    if (other.revision >= this.revision) {
      this.revision = other.revision; this.updatedAt = other.updatedAt;
      this.baseState = clone(other.baseState || (!other.dirty ? other.state : this.baseState));
    }
    this.state = merged; this.state.revision = this.revision;
    this.dirty = !sameState(this.state, this.baseState); this.raw = raw; this.edits++; this.generation++;
    return true;
  }
  writeCache(force = false) {
    try {
      const changed = !force && this.mergeCache();
      const raw = JSON.stringify(this.snapshot());
      this.storage.setItem(cacheKey(this.account.id), raw); this.raw = raw; this.cacheFailed = false;
      if (changed) this.emit();
      return true;
    } catch (e) {
      if (e instanceof ReconcileError || e instanceof SyntaxError) this.block(e);
      else { this.cacheFailed = true; this.problem('Device backup unavailable · keep this tab open and export your work.'); }
      return false;
    }
  }
  async boot() {
    if (this.booting) return this.booting;
    const generation = this.generation;
    const work = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          this.status('Reconnecting…'); const remote = await this.request('/api/account');
          if (generation !== this.generation) return false;
          await this.adopt(remote); return true;
        } catch (e) {
          if (generation !== this.generation) return false;
          if (e.status === 401) { this.status('Sign in to continue'); return false; }
          if (!transient(e) || !active() || attempt === 2) { this.problem(e.message); return false; }
          await this.wait(1000 * 2 ** attempt);
          if (!active()) { this.problem('Reconnecting… Retry when online.'); return false; }
        }
      }
    })();
    this.booting = work;
    try { return await work; } finally { if (this.booting === work) this.booting = null; }
  }
  async adopt(document) {
    const remote = documentState(document);
    clearTimeout(this.timer); this.generation++; this.edits = 0; this.sessionExpired = false; this.retryCount = 0;
    this.account = document.account; this.revision = document.revision; this.updatedAt = document.updatedAt;
    this.state = remote; this.baseState = clone(remote); this.dirty = false; this.failed = false; this.locked = false; this.conflict = null; this.replacement = false;
    this.raw = null;
    try {
      this.raw = this.storage.getItem(cacheKey(this.account.id));
      if (this.raw) {
        const cache = this.readCache(this.raw);
        if (cache.dirty) {
          this.state = cache.state; this.baseState = cache.baseState || null; this.revision = cache.revision;
          this.updatedAt = cache.updatedAt; this.localUpdatedAt = cache.localUpdatedAt; this.dirty = true; this.replacement = !!cache.replacement;
          this.reconcileRemote(document);
        }
      }
    } catch (e) { if (this.raw === null && !(e instanceof ReconcileError)) { this.cacheFailed = true; this.problem('Device backup unavailable · export your work before leaving.'); } else this.block(e, document); }
    this.emit();
    if (!this.locked) { this.writeCache(); this.savedStatus(); if (this.dirty) this.schedule(); }
  }
  reconcileRemote(document) {
    const remote = accountState(documentState(document), this.account.id);
    if (document.revision < this.revision) return false; // Stale response cannot roll back acknowledged state.
    if (this.dirty) this.journal('remote-reconcile', this.snapshot(), document);
    const merged = this.dirty ? reconcile(this.baseState, this.state, remote, {replacement: this.replacement, sameRevision: document.revision === this.revision, legacyBaseUpdatedAt: this.updatedAt}) : remote;
    this.state = merged; this.baseState = clone(remote); this.revision = document.revision; this.updatedAt = document.updatedAt;
    this.dirty = !sameState(merged, remote); if (!this.dirty) this.replacement = false;
    this.failed = false; return true;
  }
  savedStatus() {
    if (this.locked) return;
    this.status(this.dirty ? 'Saving your latest changes…' : this.cacheFailed ? 'All changes saved · device backup unavailable' : 'All changes saved');
  }
  save(state) {
    if (!this.account || this.sessionExpired) { this.problem('Sign in again before syncing. Export your work before leaving.'); return false; }
    const next = accountState(state, this.account.id);
    if (sameState(next, this.state)) return !this.cacheFailed && !this.locked;
    this.state = next; this.dirty = true; this.edits++; this.localUpdatedAt = new Date().toISOString(); this.retryCount = 0;
    if (this.locked) return false; // Leave unreadable bytes intact; the current tab remains exportable.
    const saved = this.writeCache();
    if (!this.locked && saved) { this.savedStatus(); this.schedule(); }
    else if (!this.locked) this.schedule();
    return saved;
  }
  pause() { clearTimeout(this.timer); }
  schedule(ms = 1500, read = false) {
    this.pause();
    if (!active() || this.locked || this.sessionExpired) return;
    this.timer = setTimeout(() => void (read ? this.refresh() : this.flush()), ms);
  }
  retry(read = false) {
    if (this.retryCount < 4 && active()) this.schedule(1500 * 2 ** this.retryCount++, read);
  }
  failure(e, read = false) {
    if (e.status === 401) { this.sessionExpired = true; this.pause(); this.problem('Sign-in expired · export pending work, then sign in again'); this.onAuthLost?.(); }
    else if (e instanceof ReconcileError || !e.status && e.status !== 0) this.block(e);
    else { this.problem(transient(e) ? (e.status === 0 ? e.message : 'Reconnecting… Your changes are kept on this device.') : `Sync failed · ${e.message}`); if (transient(e)) this.retry(read); }
  }
  async flush() {
    this.pause();
    if (this.inflight) return this.inflight;
    if (!active()) { if (this.dirty) this.status('Offline or paused · changes stay on this device'); return false; }
    if (!this.account || this.sessionExpired || this.locked || !this.dirty) return !this.dirty && !this.locked;
    this.writeCache(); if (this.locked) return false;
    if (!this.dirty) { this.savedStatus(); return true; }
    const generation = this.generation;
    const work = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!active() || generation !== this.generation) return false;
        const sent = clone(this.state), edits = this.edits, revision = this.revision;
        this.status('Saving your latest changes…');
        try {
          const result = await this.request('/api/profile', {method: 'PUT', headers: {'If-Match': `"${revision}"`}, body: JSON.stringify({revision, profile: sent.profiles[0], theme: sent.theme})});
          if (generation !== this.generation) return false;
          const acknowledged = accountState(documentState(result), this.account.id);
          if (result.revision < revision || !sameState(sent, acknowledged)) throw new ReconcileError('The save acknowledgement did not match. Your pending work is kept on this device.');
          this.baseState = acknowledged; this.revision = result.revision; this.updatedAt = result.updatedAt;
          this.state.revision = result.revision; this.dirty = !sameState(this.state, acknowledged);
          if (edits === this.edits) this.replacement = false;
          this.failed = false; this.retryCount = 0;
          this.writeCache(); this.savedStatus(); if (this.dirty && !this.locked) this.schedule();
          return !this.dirty && !this.locked;
        } catch (e) {
          if (generation !== this.generation) return false;
          if (e.status === 409 && e.latest) {
            try {
              this.reconcileRemote(e.latest); this.writeCache(); this.emit();
              if (this.locked || generation !== this.generation) { if (this.dirty && !this.locked) this.schedule(); return false; }
              if (!this.dirty) { this.savedStatus(); return true; }
            } catch (error) { this.block(error, e.latest); return false; }
            if (attempt < 2) { await this.wait(250 * 2 ** attempt); continue; }
            this.problem('Reconnecting… Other devices are saving. Your changes are safe on this device; retry sync.');
            return false; // Bounded races, never a modal and never endless polling.
          }
          this.failure(e); return false;
        }
      }
    })();
    this.inflight = work;
    try { return await work; } finally {
      if (this.inflight === work) { this.inflight = null; if (generation !== this.generation && this.dirty && !this.locked) this.schedule(); }
    }
  }
  async reconnect() {
    this.retryCount = 0;
    if (!active() || this.sessionExpired) return false;
    if (!this.account) return this.boot();
    return this.dirty ? this.flush() : this.refresh();
  }
  async refresh() {
    if (this.dirty) return this.flush();
    if (!this.account || this.sessionExpired || this.locked || this.inflight || this.refreshing || !active()) return false;
    this.refreshing = true; const generation = this.generation;
    try {
      const remote = await this.request('/api/account');
      if (generation !== this.generation || this.inflight) return false;
      const before = this.state;
      this.reconcileRemote(remote); this.writeCache();
      if (!sameState(before, this.state)) this.emit();
      this.retryCount = 0; this.savedStatus();
      if (this.dirty) this.schedule(); return true;
    } catch (e) { if (generation === this.generation) this.failure(e, true); return false; }
    finally { this.refreshing = false; }
  }
  async latestConflict() {
    const latest = await this.request('/api/account'); accountState(documentState(latest), this.account.id);
    this.conflict = latest; return latest;
  }
  async resolve(choice) {
    if (this.inflight) await this.inflight;
    const latest = choice === 'server' ? await this.latestConflict() : this.conflict || await this.latestConflict();
    const remote = accountState(documentState(latest), this.account.id);
    this.journal('explicit-resolution', this.snapshot(), {raw: this.raw}, latest);
    this.generation++; this.revision = latest.revision; this.updatedAt = latest.updatedAt; this.baseState = remote;
    this.locked = false; this.conflict = null; this.failed = false;
    if (choice === 'server') { this.state = remote; this.dirty = false; this.localUpdatedAt = null; this.replacement = false; }
    else { this.dirty = true; this.edits++; this.replacement = true; }
    this.writeCache(true); this.emit();
    if (choice === 'local') return this.flush();
    this.savedStatus(); return true;
  }
  rollback() {
    try { const raw = this.storage.getItem(`${cacheKey(this.account.id)}:rollback`); return raw ? JSON.parse(raw) : null; }
    catch { throw new Error('The account rollback backup could not be read.'); }
  }
  replace(next, current) {
    if (next.profiles.length !== 1 || next.activeProfileId !== this.account.id || next.profiles[0].id !== this.account.id) throw new Error('Import exactly one profile into this account.');
    if (this.locked || this.sessionExpired || this.inflight) throw new Error('Wait for syncing, resolve the account review or sign in before importing.');
    const validated = accountState(next, this.account.id);
    const backup = {app: APP, rollbackAt: new Date().toISOString(), state: clone(current), previousRaw: this.raw};
    const localUpdatedAt = new Date().toISOString();
    let raw;
    try {
      if (this.storage.getItem(cacheKey(this.account.id)) !== this.raw) throw new Error('Another tab changed the account.');
      this.storage.setItem(`${cacheKey(this.account.id)}:rollback`, JSON.stringify(backup));
      raw = JSON.stringify({...this.snapshot(), state: validated, localUpdatedAt, dirty: true, replacement: true});
      this.storage.setItem(cacheKey(this.account.id), raw);
    } catch { throw new Error('Import cancelled: a rollback and replacement could not be saved safely. Export your account first.'); }
    this.state = validated; this.raw = raw; this.localUpdatedAt = localUpdatedAt; this.dirty = true; this.replacement = true; this.edits++; this.cacheFailed = false;
    this.savedStatus(); this.schedule(); return backup;
  }
  prepareUpdate() {
    if (!this.account) return !this.dirty;
    try {
      // Keep raw bytes even for locked/corrupt caches; never require a network ack to install a fix.
      this.journal('before-app-update', this.snapshot(), {raw: this.storage.getItem(cacheKey(this.account.id))});
      if (!this.locked && !this.writeCache()) return false;
      return true;
    } catch { this.problem('Export your work before updating; device recovery is unavailable.'); return false; }
  }
  async logout() {
    if (this.inflight) await this.inflight;
    await this.request('/api/auth/logout', {method: 'POST', body: '{}'});
    this.pause(); this.generation++;
    let cleanupFailed = false;
    try { for (const key of [cacheKey(this.account.id), `${cacheKey(this.account.id)}:rollback`, recoveryKey(this.account.id), `strengthTrackerSessionEditsV1:${this.account.id}`]) this.storage.removeItem(key); } catch { cleanupFailed = true; }
    this.account = null; this.state = null; this.baseState = null; this.raw = null; this.conflict = null; this.dirty = false; this.locked = false; this.failed = false; this.sessionExpired = false;
    this.status(cleanupFailed ? 'Signed out · browser cache cleanup failed; clear this site’s data on shared devices' : 'Signed out');
  }
  storageChanged(event) {
    if (!this.account || event.key !== cacheKey(this.account.id) || this.sessionExpired || this.locked) return;
    try {
      if (!this.mergeCache()) return;
      this.writeCache(); this.emit(); this.savedStatus(); if (this.dirty) this.schedule();
    } catch (e) { this.block(e); }
  }
}
