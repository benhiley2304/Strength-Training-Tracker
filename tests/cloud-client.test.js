import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudStore, cacheKey, documentState, detectCloud, CLOUD_MARKER} from '../cloud.js';
import {APP, KEY, clone, freshState, newProfile} from '../model.js';
const id = 'a'.repeat(64);
const remote = (revision = 0, name = 'Alice') => ({account: {id, username: 'alice'}, revision, updatedAt: new Date(1700000000000 + revision * 1000).toISOString(), profile: newProfile(name, id), theme: 'light'});
function memory() { const data = new Map(); return {data, getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k)}; }
async function fixture(t, request, storage = memory()) {
  let state; const messages = [], conflicts = [];
  const store = new CloudStore({storage, request, onState: x => { state = x; }, onStatus: x => messages.push(x), onConflict: x => conflicts.push(x)});
  t.after(() => clearTimeout(store.timer)); await store.adopt(remote());
  return {store, storage, messages, conflicts, state: () => state};
}
test('cloud account starts with only the fetched remote profile; existing local multi-user data never uploads', async t => {
  const storage = memory(); storage.setItem(KEY, JSON.stringify(freshState())); const calls = [];
  const f = await fixture(t, async (...args) => { calls.push(args); return remote(); }, storage);
  assert.equal(f.state().profiles.length, 1); assert.equal(f.state().profiles[0].name, 'Alice'); assert.equal(calls.length, 0);
  assert.equal(JSON.parse(storage.getItem(KEY)).profiles.length, 3);
  assert.equal(JSON.parse(storage.getItem(cacheKey(id))).state.profiles.length, 1);
});
test('dirty changes debounce into a revision-checked snapshot and become saved only after acknowledgement', async t => {
  let release, received; const f = await fixture(t, async (path, options) => { received = {path, options}; return new Promise(resolve => { release = resolve; }); });
  const next = clone(f.state()); next.profiles[0].bw = 80;
  assert.equal(f.store.save(next), true); assert.equal(f.store.dirty, true);
  const saving = f.store.flush(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.dirty, true); assert.match(f.store.message, /Pending/); assert.equal(received.options.headers['If-Match'], '"0"');
  const result = remote(1); result.profile.bw = 80; release(result);
  assert.equal(await saving, true); assert.equal(f.store.dirty, false); assert.equal(f.store.revision, 1); assert.match(f.store.message, /All changes saved/);
});
test('edits made while a save is in flight remain dirty and use the acknowledged next revision', async t => {
  let release, count = 0; const bodies = [];
  const f = await fixture(t, async (route, options) => { bodies.push(JSON.parse(options.body)); if (++count === 1) return new Promise(r => { release = r; }); const r = remote(2); r.profile = bodies.at(-1).profile; return r; });
  const next = clone(f.state()); next.profiles[0].bw = 80; f.store.save(next);
  const saving = f.store.flush(); await new Promise(r => setImmediate(r));
  next.profiles[0].bw = 81; f.store.save(next); const r = remote(1); r.profile.bw = 80; release(r); await saving;
  assert.equal(f.store.dirty, true); assert.equal(f.store.state.profiles[0].bw, 81);
  await f.store.flush(); assert.equal(bodies[1].revision, 1); assert.equal(bodies[1].profile.bw, 81); assert.equal(f.store.dirty, false);
});
test('offline/storage service failure never resets account progress or marks it saved', async t => {
  const f = await fixture(t, async () => { throw Object.assign(new Error('Offline · not saved'), {status: 0}); });
  const next = clone(f.state()); next.profiles[0].bw = 85; f.store.save(next);
  assert.equal(await f.store.flush(), false); assert.equal(f.store.dirty, true); assert.equal(f.store.state.profiles[0].bw, 85);
  assert.equal(JSON.parse(f.storage.getItem(cacheKey(id))).state.profiles[0].bw, 85); assert.match(f.store.message, /Offline/);
});
test('409 preserves local work, exposes comparison, and never automatically retries an overwrite', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; throw Object.assign(new Error('conflict'), {status: 409, latest: remote(2, 'Phone')}); });
  const next = clone(f.state()); next.profiles[0].name = 'Desktop'; f.store.save(next); await f.store.flush();
  assert.equal(f.store.locked, true); assert.equal(f.store.state.profiles[0].name, 'Desktop'); assert.equal(f.conflicts[0].profile.name, 'Phone');
  await f.store.flush(); await f.store.refresh(); assert.equal(calls, 1);
});
test('explicit keep-local resolution uses the latest revision and further races still conflict', async t => {
  const calls = []; let conflict = true;
  const f = await fixture(t, async (route, options) => {
    calls.push(options && JSON.parse(options.body));
    if (conflict) { conflict = false; throw Object.assign(new Error('conflict'), {status: 409, latest: remote(3, 'Phone')}); }
    const result = remote(4); result.profile = calls.at(-1).profile; return result;
  });
  const next = clone(f.state()); next.profiles[0].name = 'Desktop'; f.store.save(next); await f.store.flush();
  await f.store.resolve('local'); assert.equal(calls[1].revision, 3); assert.equal(calls[1].profile.name, 'Desktop'); assert.equal(f.store.revision, 4);
});
test('explicit server reload changes only this account and does not write to GitHub', async t => {
  let writes = 0; const f = await fixture(t, async (route, options) => { if (options?.method === 'PUT') writes++; return remote(4, 'Phone'); });
  const next = clone(f.state()); next.profiles[0].name = 'Desktop'; f.store.save(next); clearTimeout(f.store.timer); f.store.locked = true; f.store.conflict = remote(3, 'Phone');
  await f.store.resolve('server'); assert.equal(f.state().profiles[0].name, 'Phone'); assert.equal(writes, 0); assert.equal(f.store.dirty, false);
});
test('clean refresh is read-only, and a response arriving after a user edit cannot overwrite it', async t => {
  let release; const calls = []; const f = await fixture(t, async (...args) => { calls.push(args); return new Promise(r => { release = r; }); });
  const refresh = f.store.refresh(); const next = clone(f.state()); next.profiles[0].name = 'Desktop'; f.store.save(next); release(remote(1, 'Phone')); await refresh;
  assert.equal(f.store.state.profiles[0].name, 'Desktop'); assert.equal(f.store.dirty, true); assert.equal(calls[0][0], '/api/account'); assert.equal(calls[0][1], undefined);
  await f.store.refresh(); assert.equal(calls.length, 1);
});
test('blocked local storage warns without crashing or claiming a device backup exists', async t => {
  const storage = {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }};
  const f = await fixture(t, async () => remote(1), storage);
  const next = clone(f.state()); next.profiles[0].bw = 80;
  assert.equal(f.store.save(next), false); assert.equal(f.store.cacheFailed, true); assert.match(f.store.message, /backup unavailable/);
  await f.store.flush(); assert.match(f.store.message, /All changes saved · device backup unavailable/);
});
test('pending per-account cache requires explicit recovery after the first remote pull', async t => {
  const storage = memory(), next = documentState(remote()); next.profiles[0].bw = 93;
  storage.setItem(cacheKey(id), JSON.stringify({account: {id, username: 'alice'}, state: next, revision: 0, dirty: true, localUpdatedAt: new Date().toISOString()}));
  let calls = 0; const f = await fixture(t, async () => { calls++; return remote(1); }, storage);
  assert.equal(f.store.state.profiles[0].bw, 93); assert.equal(f.store.locked, true); assert.equal(f.conflicts.length, 1);
  await f.store.flush(); assert.equal(calls, 0);
});
test('cross-tab cache changes pause writes and keep both versions exportable', async t => {
  const f = await fixture(t, async () => remote(1));
  const other = {...JSON.parse(f.storage.getItem(cacheKey(id))), state: documentState(remote(1, 'Other tab'))};
  f.storage.setItem(cacheKey(id), JSON.stringify(other));
  const next = clone(f.state()); next.profiles[0].name = 'This tab';
  assert.equal(f.store.save(next), false); assert.equal(f.store.locked, true);
  assert.equal(f.store.state.profiles[0].name, 'This tab'); assert.equal(JSON.parse(f.storage.getItem(cacheKey(id))).state.profiles[0].name, 'Other tab');
});
test('logout clears active account memory/cache but never another account or local profiles', async t => {
  const f = await fixture(t, async () => ({ok: true})); f.storage.setItem(cacheKey('b'.repeat(64)), 'other-user-cache'); f.storage.setItem(KEY, 'local-profiles');
  await f.store.logout(); assert.equal(f.store.state, null); assert.equal(f.store.account, null); assert.equal(f.store.raw, null); assert.equal(f.storage.getItem(cacheKey(id)), null);
  assert.equal(f.storage.getItem(cacheKey('b'.repeat(64))), 'other-user-cache'); assert.equal(f.storage.getItem(KEY), 'local-profiles');
});
test('cloud import refuses multiple profiles and refuses replacement when rollback cannot be written', async t => {
  const f = await fixture(t, async () => remote(1)); assert.throws(() => f.store.replace(freshState(), f.state()), /exactly one/);
  f.storage.setItem = () => { throw new Error('full'); };
  const next = clone(f.state()); next.profiles[0].bw = 75;
  assert.throws(() => f.store.replace(next, f.state()), /rollback/); assert.equal(f.store.state.profiles[0].bw, null);
});
test('static non-JSON API fallbacks stay local, but known cloud outages never downgrade to local', async t => {
  const originalFetch = globalThis.fetch, originalStorage = globalThis.localStorage;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; });
  globalThis.localStorage = memory(); globalThis.fetch = async () => new Response('Not found', {status: 404, headers: {'Content-Type': 'text/html'}});
  assert.equal(await detectCloud(), 'local');
  globalThis.fetch = async () => new Response('<html>static rewrite</html>', {headers: {'Content-Type': 'text/html'}}); assert.equal(await detectCloud(), 'local');
  globalThis.localStorage.setItem(CLOUD_MARKER, 'true'); assert.equal(await detectCloud(), 'unavailable');
  globalThis.fetch = async () => { throw new Error('offline'); }; assert.equal(await detectCloud(), 'unavailable');
  globalThis.localStorage.removeItem(CLOUD_MARKER); globalThis.localStorage.setItem(KEY, JSON.stringify(freshState())); assert.equal(await detectCloud(), 'local');
});
