import {APP, KEY, clone, validateState} from './model.js';
export const CLOUD_MARKER = 'strengthTrackerCloudHostV1';
export const cacheKey = id => `strengthTrackerCloudCacheV1:${id}`;
export async function api(path, options = {}) {
  let response;
  try { response = await fetch(path, {credentials: 'same-origin', cache: 'no-store', ...options, signal: options.signal || AbortSignal.timeout(90000), headers: {'Content-Type': 'application/json', ...options.headers}}); }
  catch { throw Object.assign(new Error(navigator.onLine === false ? 'Offline · changes are kept on this device. Reconnect to sync.' : 'Connection unavailable · changes are not confirmed saved. Please retry; the service may be waking up.'), {status: 0}); }
  if (!response.headers.get('content-type')?.includes('application/json')) throw Object.assign(new Error('Connection unavailable · unexpected response. Your work has not been reset.'), {status: 0});
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Request failed. Please try again.'), {status: response.status, latest: data.latest});
  return data;
}
export async function detectCloud() {
  let known = false;
  try { known = localStorage.getItem(CLOUD_MARKER) === 'true'; } catch { /* Optional mode hint only. */ }
  try {
    const response = await fetch('/api/config', {cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(12000)});
    const json = response.headers.get('content-type')?.includes('application/json');
    if (response.ok && json && (await response.json()).cloud === true) {
      try { localStorage.setItem(CLOUD_MARKER, 'true'); } catch { /* Storage may be blocked. */ }
      return 'cloud';
    }
    // A static host may return a non-JSON 404 or rewrite the path to index.html.
    if (!known && (response.status === 404 || (response.ok && !json))) return 'local';
    return 'unavailable';
  } catch {
    try { if (!known && localStorage.getItem(KEY)) return 'local'; } catch { /* Cannot infer offline host mode. */ }
    return 'unavailable';
  }
}
export function documentState(data) {
  if (!data?.account || data.profile?.id !== data.account.id) throw new Error('Invalid account response.');
  return validateState({app: APP, version: 3, revision: data.revision, theme: data.theme, activeProfileId: data.account.id, profiles: [data.profile]});
}
export class CloudStore {
  constructor({onState, onStatus, onConflict, onAuthLost, storage = {getItem: key => globalThis.localStorage.getItem(key), setItem: (key, value) => globalThis.localStorage.setItem(key, value), removeItem: key => globalThis.localStorage.removeItem(key)}, request = api} = {}) {
    this.onState = onState; this.onStatus = onStatus; this.onConflict = onConflict; this.onAuthLost = onAuthLost;
    this.storage = storage; this.request = request; this.account = null; this.state = null; this.raw = null;
    this.dirty = false; this.failed = false; this.locked = false; this.conflict = null; this.timer = null; this.inflight = null; this.refreshing = false; this.generation = 0; this.edits = 0; this.sessionExpired = false;
  }
  status(message) { this.message = message; this.onStatus?.(message); }
  problem(message) { this.failed = true; this.status(message); }
  writeCache(force = false) {
    try {
      const key = cacheKey(this.account.id);
      if (!force && this.storage.getItem(key) !== this.raw) { this.locked = true; this.status('Conflict · another tab changed this account. Export your work, then resolve.'); return false; }
      const raw = JSON.stringify({account: this.account, state: this.state, revision: this.revision, updatedAt: this.updatedAt, localUpdatedAt: this.localUpdatedAt, dirty: this.dirty});
      this.storage.setItem(key, raw); this.raw = raw; this.cacheFailed = false; return true;
    } catch { this.cacheFailed = true; this.problem('Device backup unavailable · keep this tab open and export your work.'); return false; }
  }
  async boot() {
    try { await this.adopt(await this.request('/api/account')); return true; }
    catch (e) { if (e.status !== 401) this.problem(e.message); else this.status('Sign in to continue'); return false; }
  }
  async adopt(document) {
    const remote = documentState(document);
    clearTimeout(this.timer); this.generation++; this.edits = 0; this.sessionExpired = false;
    this.account = document.account; this.revision = document.revision; this.updatedAt = document.updatedAt;
    this.state = remote; this.dirty = false; this.failed = false; this.locked = false; this.conflict = null;
    let cache;
    try { this.raw = this.storage.getItem(cacheKey(this.account.id)); cache = this.raw ? JSON.parse(this.raw) : null; }
    catch { this.raw = null; this.cacheFailed = true; }
    if (cache?.dirty && cache.account?.id === this.account.id) {
      try {
        const restored = validateState(cache.state);
        if (restored.profiles.length !== 1 || restored.activeProfileId !== this.account.id) throw new Error();
        this.state = restored; this.revision = cache.revision; this.updatedAt = cache.updatedAt; this.localUpdatedAt = cache.localUpdatedAt; this.dirty = true; this.conflict = document; this.locked = true;
      } catch { this.problem('A device snapshot could not be read. The server version is open; unreadable bytes remain available to export.'); this.locked = true; }
    }
    this.onState?.(this.state);
    if (this.conflict) { this.status('Conflict · recover device changes or use the server version'); this.onConflict?.(this.conflict); }
    else if (!this.locked) { this.writeCache(); this.status(this.cacheFailed ? 'Account loaded · device backup unavailable' : 'All changes saved'); }
  }
  save(state) {
    if (!this.account || this.sessionExpired) { this.problem('Sign in again before syncing. Export your work before leaving.'); return false; }
    this.state = clone(state); this.dirty = true; this.edits++; this.localUpdatedAt = new Date().toISOString();
    const saved = this.writeCache();
    if (!this.locked) { this.status(saved ? 'Pending · saved on this device, syncing soon' : 'Pending · device backup unavailable; export now'); this.schedule(); }
    return saved;
  }
  schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => void this.flush(), 1500); }
  async flush() {
    clearTimeout(this.timer);
    if (this.inflight) { await this.inflight; if (this.dirty && !this.failed && !this.locked) return this.flush(); return !this.dirty && !this.failed; }
    if (!this.account || this.sessionExpired || this.locked || !this.dirty) return !this.dirty && !this.locked;
    const generation = this.generation, edits = this.edits, state = clone(this.state);
    this.status('Pending · saving online');
    this.inflight = (async () => {
      try {
        const result = await this.request('/api/profile', {method: 'PUT', headers: {'If-Match': `"${this.revision}"`}, body: JSON.stringify({revision: this.revision, profile: state.profiles[0], theme: state.theme})});
        if (generation !== this.generation) return;
        documentState(result);
        this.revision = result.revision; this.updatedAt = result.updatedAt; this.state.revision = result.revision; this.failed = false;
        this.dirty = this.edits !== edits;
        this.writeCache();
        this.status(this.locked ? 'Conflict · another tab changed this account' : this.dirty ? 'Pending · more changes waiting' : this.cacheFailed ? 'All changes saved · device backup unavailable' : `All changes saved · ${new Date(result.updatedAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`);
        if (this.dirty && !this.locked) this.schedule();
      } catch (e) {
        if (generation !== this.generation) return;
        this.failed = true;
        if (e.status === 409 && e.latest) { this.conflict = e.latest; this.locked = true; this.status('Conflict · another device changed this account'); this.onConflict?.(e.latest); }
        else if (e.status === 401) { this.sessionExpired = true; this.status('Sign-in expired · export pending work, then sign in again'); this.onAuthLost?.(); }
        else this.status(e.status === 0 ? e.message : `Sync failed · ${e.message}`);
      }
    })();
    try { await this.inflight; } finally { this.inflight = null; }
    return !this.dirty && !this.failed && !this.locked;
  }
  async refresh() {
    if (!this.account || this.sessionExpired || this.dirty || this.locked || this.inflight || this.refreshing || globalThis.document?.visibilityState === 'hidden') return;
    this.refreshing = true; const generation = this.generation, edits = this.edits;
    try {
      const remote = await this.request('/api/account'); documentState(remote);
      if (generation !== this.generation || this.dirty || this.edits !== edits) return;
      if (remote.revision !== this.revision) {
        try {
          if (this.storage.getItem(cacheKey(this.account.id)) !== this.raw) { this.locked = true; this.status('Conflict · another tab changed this account'); return; }
        } catch { this.cacheFailed = true; }
        this.revision = remote.revision; this.updatedAt = remote.updatedAt; this.state = documentState(remote);
        this.writeCache(); if (!this.locked) this.onState?.(this.state);
      }
      this.failed = false; this.status(this.locked ? 'Conflict · another tab changed this account' : this.cacheFailed ? 'All changes saved · device backup unavailable' : 'All changes saved');
    } catch (e) {
      if (generation !== this.generation) return;
      if (e.status === 401) { this.sessionExpired = true; this.onAuthLost?.(); }
      this.problem(e.status === 401 ? 'Sign-in expired · sign in again' : e.message);
    } finally { this.refreshing = false; }
  }
  async latestConflict() {
    const latest = await this.request('/api/account'); documentState(latest);
    if (latest.account.id !== this.account?.id) throw new Error('Account changed. Sign in again.');
    this.conflict = latest; return latest;
  }
  async resolve(choice) {
    if (this.inflight) await this.inflight;
    const latest = choice === 'server' ? await this.latestConflict() : this.conflict || await this.latestConflict();
    documentState(latest);
    this.revision = latest.revision; this.updatedAt = latest.updatedAt; this.locked = false; this.conflict = null; this.failed = false;
    if (choice === 'server') { this.state = documentState(latest); this.dirty = false; this.localUpdatedAt = null; }
    else { this.dirty = true; this.edits++; }
    this.writeCache(true); this.onState?.(this.state);
    if (choice === 'local') return this.flush();
    this.status(this.cacheFailed ? 'Server version loaded · device backup unavailable' : 'All changes saved · server version loaded'); return true;
  }
  rollback() {
    try { const raw = this.storage.getItem(`${cacheKey(this.account.id)}:rollback`); return raw ? JSON.parse(raw) : null; }
    catch { throw new Error('The account rollback backup could not be read.'); }
  }
  replace(next, current) {
    if (next.profiles.length !== 1 || next.activeProfileId !== this.account.id || next.profiles[0].id !== this.account.id) throw new Error('Import exactly one profile into this account.');
    if (this.locked || this.sessionExpired) throw new Error('Resolve the account conflict or sign in before importing.');
    const validated = validateState(next);
    const backup = {app: APP, rollbackAt: new Date().toISOString(), state: clone(current), previousRaw: this.raw};
    const localUpdatedAt = new Date().toISOString();
    let raw;
    try {
      if (this.storage.getItem(cacheKey(this.account.id)) !== this.raw) { this.locked = true; throw new Error('Another tab changed the account.'); }
      this.storage.setItem(`${cacheKey(this.account.id)}:rollback`, JSON.stringify(backup));
      raw = JSON.stringify({account: this.account, state: validated, revision: this.revision, updatedAt: this.updatedAt, localUpdatedAt, dirty: true});
      this.storage.setItem(cacheKey(this.account.id), raw);
    } catch { throw new Error('Import cancelled: a rollback and replacement could not be saved safely. Export your account first, and resolve any other-tab changes.'); }
    this.state = validated; this.raw = raw; this.localUpdatedAt = localUpdatedAt; this.dirty = true; this.edits++; this.cacheFailed = false;
    this.status('Pending · selected profile saved on this device, syncing soon'); this.schedule();
    return backup;
  }
  async logout() {
    if (this.inflight) await this.inflight;
    await this.request('/api/auth/logout', {method: 'POST', body: '{}'});
    clearTimeout(this.timer); this.generation++;
    let cleanupFailed = false;
    try { this.storage.removeItem(cacheKey(this.account.id)); this.storage.removeItem(`${cacheKey(this.account.id)}:rollback`); } catch { cleanupFailed = true; }
    this.account = null; this.state = null; this.raw = null; this.conflict = null; this.dirty = false; this.locked = false; this.failed = false; this.sessionExpired = false;
    this.status(cleanupFailed ? 'Signed out · browser cache cleanup failed; clear this site’s data on shared devices' : 'Signed out');
  }
  storageChanged(event) {
    if (this.account && event.key === cacheKey(this.account.id) && event.newValue !== this.raw) {
      clearTimeout(this.timer); this.locked = true; this.status('Conflict · another tab changed this account. Export this tab before resolving.');
    }
  }
}
