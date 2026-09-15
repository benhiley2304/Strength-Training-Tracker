import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudStore, cacheKey, recoveryKey, documentState, detectCloud, CLOUD_MARKER, api} from '../cloud.js';
import {reconcile, sameState, equalData, ReconcileError} from '../sync-merge.js';
import {clone, newProfile, newDraft, blankSet, readiness} from '../model.js';
const id = 'a'.repeat(64), otherId = 'b'.repeat(64);
const remote = (revision = 5) => ({account: {id, username: 'synthetic'}, profile: newProfile('Synthetic', id), theme: 'light', revision, updatedAt: '2026-09-15T18:15:00.000Z'});
const history = (id, session = 1) => ({id, session, cycle: 1, date: '2026-09-15T18:00:00.000Z', name: 'Synthetic session', notes: '', conditioning: 'None', startedAt: 1700000000000, durationSeconds: 60, bwSnapshot: null, readiness: readiness(), partial: true, sets: []});
const state = () => documentState(remote());
const mem = () => { const data = new Map(); return {getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k)}; };
function pending(storage, local, {base = state(), revision = 5, replacement = false} = {}) {
  storage.setItem(cacheKey(id), JSON.stringify({account: remote().account, state: local, baseState: base, revision, dirty: true, replacement, updatedAt: '2026-09-15T18:00:00.000Z', localUpdatedAt: '2026-09-15T21:16:00.000Z'}));
}
function setup(t, {storage = mem(), request, onAuthLost, onState} = {}) {
  let document = remote(), calls = [], conflicts = [];
  const store = new CloudStore({storage, wait: async () => {}, onAuthLost, onState, onConflict: x => conflicts.push(x), request: request || (async (route, options) => {
    calls.push({route, options});
    if (options?.method === 'PUT') { const body = JSON.parse(options.body); document = {...document, profile: body.profile, theme: body.theme, revision: body.revision + 1}; }
    return clone(document);
  })});
  t.after(() => store.pause());
  return {store, storage, calls, conflicts};
}
test('same-revision dirty cache automatically replays and durably advances its acknowledged base', async t => {
  const storage = mem(), local = state(); local.profiles[0].bw = 83;
  pending(storage, local); const f = setup(t, {storage}); await f.store.adopt(remote());
  assert.equal(f.store.locked, false); assert.equal(f.store.dirty, true); assert.equal(f.conflicts.length, 0);
  await f.store.flush(); assert.equal(f.calls.length, 1); assert.equal(f.store.dirty, false);
  const cache = JSON.parse(storage.getItem(cacheKey(id))); assert.equal(cache.baseState.profiles[0].bw, 83); assert.equal(cache.revision, 6);
});
test('stale dirty flags and lost-ack caches clear without a PUT even when revisions differ', async t => {
  for (const revision of [5, 6, 9]) {
    const storage = mem(); pending(storage, state()); const f = setup(t, {storage}); await f.store.adopt(remote(revision));
    await f.store.flush(); assert.equal(f.store.dirty, false); assert.equal(f.store.revision, revision); assert.equal(f.calls.length, 0);
  }
});
test('same payload comparison is key-order independent and ignores only empty render-created drafts', () => {
  assert.equal(equalData({a: 1, b: {c: 2}}, {b: {c: 2}, a: 1}), true);
  const b = state(), l = clone(b); l.profiles[0].drafts[1] = newDraft(l.profiles[0]);
  assert.equal(sameState(b, l), true); l.profiles[0].drafts[1].notes = 'User effort'; assert.equal(sameState(b, l), false);
});
test('known baseline merges pending fields and preserves independent remote preferences and set edits', () => {
  const b = state(); b.profiles[0].drafts[1] = newDraft(b.profiles[0]);
  const l = clone(b), r = clone(b);
  l.profiles[0].bw = 82; l.profiles[0].drafts[1].exercises[0].sets[0].kg = '60';
  r.profiles[0].restSeconds = 180; r.profiles[0].drafts[1].notes = 'Remote note'; r.profiles[0].drafts[1].exercises[0].sets[0].reps = '8'; r.theme = 'dark';
  const merged = reconcile(b, l, r), p = merged.profiles[0];
  assert.equal(p.bw, 82); assert.equal(p.restSeconds, 180); assert.equal(merged.theme, 'dark');
  assert.equal(p.drafts[1].notes, 'Remote note'); assert.equal(p.drafts[1].exercises[0].sets[0].kg, '60'); assert.equal(p.drafts[1].exercises[0].sets[0].reps, '8');
});
test('actual local field edits win collisions, regardless of wall-clock time', () => {
  const b = state(), l = clone(b), r = clone(b); l.profiles[0].bw = 81; r.profiles[0].bw = 91; r.profiles[0].name = 'Remote';
  const p = reconcile(b, l, r).profiles[0]; assert.equal(p.bw, 81); assert.equal(p.name, 'Remote');
});
test('independent histories merge by stable ID with independent changes within shared records', () => {
  const b = state(); b.profiles[0].history = [history('shared')]; const l = clone(b), r = clone(b);
  l.profiles[0].history.push(history('desktop', 2)); r.profiles[0].history.push(history('phone', 3));
  l.profiles[0].history[0].notes = 'Local note'; r.profiles[0].history[0].conditioning = 'Remote conditioning';
  const h = reconcile(b, l, r).profiles[0].history;
  assert.deepEqual(h.map(x => x.id).sort(), ['desktop', 'phone', 'shared']); assert.equal(h[0].notes, 'Local note'); assert.equal(h[0].conditioning, 'Remote conditioning');
});
test('a remotely finished draft cannot be resurrected even if the stale device edited it', () => {
  const b = state(); b.profiles[0].drafts[1] = newDraft(b.profiles[0]); const draftId = b.profiles[0].drafts[1].id;
  const l = clone(b), r = clone(b); l.profiles[0].drafts[1].notes = 'Stale edit'; delete r.profiles[0].drafts[1]; r.profiles[0].history.push(history(draftId)); r.profiles[0].completed = [1]; r.profiles[0].current = 2;
  const p = reconcile(b, l, r).profiles[0]; assert.equal(p.drafts[1], undefined); assert.equal(p.history.length, 1); assert.equal(p.current, 2);
});
test('legacy cache cannot resurrect a different-ID stale session after remote finish, but new effort can start later', () => {
  const l = state(), r = state(); l.profiles[0].drafts[1] = newDraft(l.profiles[0]); l.profiles[0].drafts[1].notes = 'Old effort'; l.profiles[0].drafts[1].startedAt = 1700000000000;
  r.profiles[0].history.push(history('finished')); r.profiles[0].current = 2;
  assert.equal(reconcile(null, l, r).profiles[0].drafts[1], undefined);
  l.profiles[0].drafts[1].startedAt = Date.parse('2026-09-15T19:00:00Z');
  assert.equal(reconcile(null, l, r).profiles[0].drafts[1].notes, 'Old effort');
});
test('V1 screenshot-shaped cache rev5 edited21:16 versus rev6 saved18:15 reconciles without a modal and archives both full versions', async t => {
  const storage = mem(), l = state(), r = remote(6); l.profiles[0].bw = 86; l.profiles[0].restSeconds = 120;
  l.profiles[0].drafts[1] = newDraft(l.profiles[0]); r.profile.drafts[1] = newDraft(r.profile); r.profile.drafts[1].notes = 'Remote pending effort';
  pending(storage, l, {base: undefined}); // Explicitly remove base, matching V1 schema.
  const old = JSON.parse(storage.getItem(cacheKey(id))); delete old.baseState; storage.setItem(cacheKey(id), JSON.stringify(old));
  const f = setup(t, {storage}); await f.store.adopt(r);
  assert.equal(f.store.locked, false); assert.equal(f.conflicts.length, 0); assert.equal(f.store.state.profiles[0].bw, 86); assert.equal(f.store.state.profiles[0].drafts[1].notes, 'Remote pending effort');
  const journal = JSON.parse(storage.getItem(recoveryKey(id))); assert.deepEqual(journal[0].snapshots[0].state, l); assert.deepEqual(journal[0].snapshots[1], r);
  assert.equal(f.store.state.profiles[0].history.length, 0); await f.store.flush(); assert.equal(f.store.dirty, false);
});
test('legacy history unions preserve both devices and empty bodyweight does not erase a remote value', () => {
  const l = state(), r = state(); l.profiles[0].history.push(history('local')); r.profiles[0].history.push(history('remote', 2)); r.profiles[0].bw = 92;
  const p = reconcile(null, l, r).profiles[0]; assert.equal(p.history.length, 2); assert.equal(p.bw, 92);
});
test('different unfinished efforts in the same slot prompt rather than destroying either', () => {
  const l = state(), r = state(); l.profiles[0].drafts[1] = newDraft(l.profiles[0]); r.profiles[0].drafts[1] = newDraft(r.profiles[0]);
  l.profiles[0].drafts[1].notes = 'Left'; r.profiles[0].drafts[1].notes = 'Right';
  assert.throws(() => reconcile(state(), l, r), ReconcileError);
});
test('independently appended sets survive merges; concurrent positional deletions need review', () => {
  const b = state(); b.profiles[0].drafts[1] = newDraft(b.profiles[0]); const l = clone(b), r = clone(b);
  l.profiles[0].drafts[1].exercises[0].sets[0].kg = '40'; r.profiles[0].drafts[1].exercises[0].sets.push({...blankSet(), reps: '8'});
  assert.equal(reconcile(b, l, r).profiles[0].drafts[1].exercises[0].sets.length, r.profiles[0].drafts[1].exercises[0].sets.length);
});
test('cycle reset is not rolled back by stale drafts or stale navigation', () => {
  const b = state(); b.profiles[0].drafts[1] = newDraft(b.profiles[0]); const l = clone(b), r = clone(b);
  l.profiles[0].current = 3; l.profiles[0].bw = 80; r.profiles[0].cycle = 2; r.profiles[0].drafts = {};
  const p = reconcile(b, l, r).profiles[0]; assert.equal(p.cycle, 2); assert.equal(p.current, 1); assert.deepEqual(p.drafts, {}); assert.equal(p.bw, 80);
});
test('imports persist their replace marker through reboot and never union intentionally removed history', async t => {
  const f = setup(t); const r = remote(); r.profile.history = [history('will-be-replaced')]; await f.store.adopt(r);
  const imported = state(); imported.profiles[0].name = 'Imported'; f.store.replace(imported, f.store.state); f.store.pause();
  assert.equal(JSON.parse(f.storage.getItem(cacheKey(id))).replacement, true);
  const reopened = setup(t, {storage: f.storage}); await reopened.store.adopt(r); assert.equal(reopened.store.state.profiles[0].history.length, 0); assert.equal(reopened.store.locked, false);
  await reopened.store.flush(); assert.equal(reopened.store.replacement, false);
});
test('pending import versus newer remote edits remains an explicit deliberate-confirm flow', async t => {
  const f = setup(t); await f.store.adopt(remote()); const imported = state(); imported.profiles[0].name = 'Imported';
  f.store.replace(imported, f.store.state); f.store.pause(); const r = remote(6); r.profile.bw = 88;
  const reopened = setup(t, {storage: f.storage}); await reopened.store.adopt(r); assert.equal(reopened.store.locked, true); assert.equal(reopened.conflicts.length, 1); assert.equal(reopened.calls.length, 0); assert.equal(reopened.store.state.profiles[0].name, 'Imported');
});
test('an inferred remote destructive replacement never resurrects removed historical IDs', () => {
  const b = state(); b.profiles[0].history.push(history('removed')); const l = clone(b), r = clone(b); l.profiles[0].bw = 80; r.profiles[0].history = [];
  assert.throws(() => reconcile(b, l, r), /history was replaced/);
});
test('no-op inputs and repeated blank rendering do not dirty the cache or make extra writes', async t => {
  let emitted; const f = setup(t, {onState: x => { emitted = x; }}); await f.store.adopt(remote()); const raw = f.store.raw;
  emitted.profiles[0].drafts[1] = newDraft(emitted.profiles[0]); assert.equal(f.store.save(emitted), true); await f.store.flush();
  assert.equal(f.store.dirty, false); assert.equal(f.calls.length, 0); assert.equal(f.store.raw, raw);
  emitted.profiles[0].bw = 81; assert.equal(f.store.save(emitted), true); assert.equal(f.store.dirty, true); // UI copy mutation still detected.
});
test('offline reconnect flushes dirty work instead of refusing to refresh it; hidden/offline pause writes', async t => {
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), oldDocument = globalThis.document;
  const navigator = {onLine: false}; Object.defineProperty(globalThis, 'navigator', {value: navigator, configurable: true}); globalThis.document = {visibilityState: 'visible'};
  t.after(() => { if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator; globalThis.document = oldDocument; });
  const f = setup(t); await f.store.adopt(remote()); const l = state(); l.profiles[0].bw = 85; f.store.save(l);
  await f.store.refresh(); assert.equal(f.calls.length, 0); assert.equal(f.store.dirty, true);
  navigator.onLine = true; document.visibilityState = 'hidden'; await f.store.reconnect(); assert.equal(f.calls.length, 0);
  document.visibilityState = 'visible'; await f.store.reconnect(); assert.equal(f.calls.length, 1); assert.equal(f.store.dirty, false);
});
test('transient retries are exponentially backed off and stop after four scheduled attempts', async t => {
  const f = setup(t, {request: async () => { throw Object.assign(new Error('temporary'), {status: 503}); }}); await f.store.adopt(remote());
  const l = state(); l.profiles[0].bw = 85; f.store.save(l); f.store.pause(); const delays = []; f.store.schedule = ms => delays.push(ms);
  for (let i = 0; i < 6; i++) await f.store.flush();
  assert.deepEqual(delays, [1500, 3000, 6000, 12000]); assert.equal(f.store.dirty, true); assert.equal(f.store.locked, false);
});
test('boot transient reads retry boundedly before exposing any account data; real 401 does not retry', async t => {
  let count = 0, emits = 0; const f = setup(t, {onState: () => emits++, request: async () => { if (++count < 3) throw Object.assign(new Error('starting'), {status: 503}); return remote(); }});
  await f.store.boot(); assert.equal(count, 3); assert.equal(emits, 1);
  const unauthorized = setup(t, {request: async () => { throw Object.assign(new Error('Unauthorized'), {status: 401}); }});
  assert.equal(await unauthorized.store.boot(), false); assert.equal(unauthorized.store.state, null); assert.equal(unauthorized.store.account, null);
});
test('401 while saving hides the signed-in session, preserves pending bytes and never auto retries', async t => {
  let lost = 0, calls = 0; const f = setup(t, {onAuthLost: () => lost++, request: async () => { calls++; throw Object.assign(new Error('expired'), {status: 401}); }});
  await f.store.adopt(remote()); const l = state(); l.profiles[0].bw = 80; f.store.save(l); await f.store.flush(); await f.store.reconnect();
  assert.equal(lost, 1); assert.equal(calls, 1); assert.equal(f.store.sessionExpired, true); assert.equal(JSON.parse(f.storage.getItem(cacheKey(id))).dirty, true);
});
test('a refresh arriving after a newer save ack cannot roll back state or baseline', async t => {
  let finishRead; const f = setup(t, {request: async (route, options) => { if (!options) return new Promise(resolve => { finishRead = resolve; }); const r = remote(7); r.profile = JSON.parse(options.body).profile; return r; }});
  await f.store.adopt(remote()); const refreshing = f.store.refresh(); const l = state(); l.profiles[0].bw = 84; f.store.save(l); await f.store.flush(); finishRead(remote(6)); await refreshing;
  assert.equal(f.store.revision, 7); assert.equal(f.store.state.profiles[0].bw, 84); assert.equal(f.store.baseState.profiles[0].bw, 84); assert.equal(f.store.dirty, false);
});
test('old in-flight account replies cannot overwrite a newly adopted account generation', async t => {
  let release; const f = setup(t, {request: async () => new Promise(resolve => { release = resolve; })}); await f.store.adopt(remote());
  const l = state(); l.profiles[0].bw = 80; f.store.save(l); const saving = f.store.flush();
  const another = remote(20); another.account = {id: otherId, username: 'other-synthetic'}; another.profile = newProfile('Other synthetic', otherId); await f.store.adopt(another);
  const ack = remote(6); ack.profile.bw = 80; release(ack); await saving;
  assert.equal(f.store.account.id, otherId); assert.equal(f.store.revision, 20); assert.equal(f.store.state.profiles[0].bw, null);
});
test('storage events reconcile account-scoped tab changes and ignore stale event values', async t => {
  const storage = mem(), a = setup(t, {storage}), b = setup(t, {storage}); await a.store.adopt(remote()); await b.store.adopt(remote());
  const left = state(); left.profiles[0].bw = 80; a.store.save(left);
  const right = state(); right.profiles[0].restSeconds = 180; b.store.save(right); // Synchronous read/merge/write protects a pending edit even before its event.
  a.store.storageChanged({key: cacheKey(id), newValue: 'deliberately stale event'});
  assert.equal(a.store.state.profiles[0].bw, 80); assert.equal(a.store.state.profiles[0].restSeconds, 180); assert.equal(a.store.locked, false);
  const raw = a.store.raw; a.store.storageChanged({key: cacheKey(otherId), newValue: '{}'}); assert.equal(a.store.raw, raw);
  await a.store.flush(); b.store.storageChanged({key: cacheKey(id), newValue: 'older event'}); assert.equal(b.store.dirty, false); assert.equal(b.store.revision, 6);
});
test('a stale clean tab cache cannot roll back an acknowledged revision', async t => {
  const f = setup(t); await f.store.adopt(remote()); const stale = f.store.raw; const l = state(); l.profiles[0].bw = 80; f.store.save(l); await f.store.flush();
  f.storage.setItem(cacheKey(id), stale); f.store.storageChanged({key: cacheKey(id)});
  assert.equal(f.store.revision, 6); assert.equal(f.store.state.profiles[0].bw, 80); assert.equal(f.store.dirty, false);
});
test('other-tab acknowledgement during an in-flight write invalidates the old reply safely', async t => {
  let release; const storage = mem(), a = setup(t, {storage, request: async () => new Promise(resolve => { release = resolve; })}); await a.store.adopt(remote());
  const l = state(); l.profiles[0].bw = 80; a.store.save(l); const saving = a.store.flush();
  const b = setup(t, {storage}); await b.store.adopt(remote()); const right = clone(b.store.state); right.profiles[0].restSeconds = 180; b.store.save(right); await b.store.flush();
  a.store.storageChanged({key: cacheKey(id)}); const ack = remote(6); ack.profile.bw = 80; release(ack); await saving;
  assert.equal(a.store.state.profiles[0].restSeconds, 180); assert.equal(a.store.state.profiles[0].bw, 80); assert.equal(a.store.dirty, false);
});
test('malformed or cross-account cache bytes remain exportable and are never uploaded or overwritten', async t => {
  for (const raw of ['{broken', JSON.stringify({account: {id: otherId}, state: state(), dirty: true, revision: 5})]) {
    const storage = mem(); storage.setItem(cacheKey(id), raw); const f = setup(t, {storage}); await f.store.adopt(remote());
    assert.equal(f.store.locked, true); assert.equal(storage.getItem(cacheKey(id)), raw); await f.store.flush(); assert.equal(f.calls.length, 0); assert.equal(f.store.recovery().previousRaw, raw);
    assert.equal(f.store.prepareUpdate(), true); assert.equal(storage.getItem(cacheKey(id)), raw); assert.ok(storage.getItem(recoveryKey(id)).includes('before-app-update'));
  }
});
test('recovery journal is rolling, account-private and cleared with logout', async t => {
  const f = setup(t, {request: async () => ({ok: true})}); await f.store.adopt(remote()); f.storage.setItem(recoveryKey(otherId), 'another account');
  for (let i = 0; i < 9; i++) f.store.journal('synthetic', {i});
  const journal = JSON.parse(f.storage.getItem(recoveryKey(id))); assert.equal(journal.length, 5); assert.equal(journal[0].snapshots[0].i, 4);
  await f.store.logout(); assert.equal(f.storage.getItem(recoveryKey(id)), null); assert.equal(f.storage.getItem(recoveryKey(otherId)), 'another account');
});
test('update preparation persists pending state and full recovery offline without a PUT; quota errors block activation', async t => {
  const f = setup(t); await f.store.adopt(remote()); const l = state(); l.profiles[0].bw = 80; f.store.save(l);
  assert.equal(f.store.prepareUpdate(), true); assert.equal(JSON.parse(f.storage.getItem(cacheKey(id))).state.profiles[0].bw, 80); assert.equal(f.calls.length, 0);
  f.storage.setItem = () => { throw new Error('quota'); }; assert.equal(f.store.prepareUpdate(), false);
});
test('known cloud host skips config; unknown startup retries but static HTML 404 remains local', async t => {
  const oldFetch = globalThis.fetch, oldStorage = globalThis.localStorage; t.after(() => { globalThis.fetch = oldFetch; globalThis.localStorage = oldStorage; });
  globalThis.localStorage = mem(); localStorage.setItem(CLOUD_MARKER, 'true'); globalThis.fetch = () => { throw new Error('must not probe'); }; assert.equal(await detectCloud(), 'cloud');
  localStorage.removeItem(CLOUD_MARKER); let calls = 0, waits = []; globalThis.fetch = async () => ++calls < 3 ? new Response('<html>starting</html>', {status: 503}) : Response.json({cloud: true});
  assert.equal(await detectCloud({wait: async ms => waits.push(ms)}), 'cloud'); assert.deepEqual(waits, [1000, 2000]); assert.equal(calls, 3);
  localStorage.removeItem(CLOUD_MARKER); globalThis.fetch = async () => new Response('<html>not found</html>', {status: 404}); assert.equal(await detectCloud(), 'local');
});
test('API malformed JSON and non-JSON startup responses become retryable read errors, not conflicts', async t => {
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async () => new Response('{', {headers: {'content-type': 'application/json'}}); await assert.rejects(api('/api/account'), {status: 0});
  globalThis.fetch = async () => new Response('starting', {status: 503}); await assert.rejects(api('/api/account'), {status: 503});
});

test('a stale finished draft does not conflict with a genuinely new remote effort in the same slot', () => {
  const b = state(); b.profiles[0].drafts[1] = newDraft(b.profiles[0]); b.profiles[0].drafts[1].notes = 'Old session';
  const l = clone(b), r = clone(b); l.profiles[0].bw = 80;
  r.profiles[0].history = [history(b.profiles[0].drafts[1].id)]; r.profiles[0].drafts[1] = newDraft(r.profiles[0]); r.profiles[0].drafts[1].notes = 'New session'; r.profiles[0].drafts[1].startedAt = Date.parse('2026-09-15T20:00:00Z');
  const merged = reconcile(b, l, r).profiles[0]; assert.equal(merged.drafts[1].notes, 'New session'); assert.equal(merged.history.length, 1); assert.equal(merged.bw, 80);
});
test('a tab discovering another tab already acknowledged its payload clears dirty without another PUT', async t => {
  const storage = mem(), a = setup(t, {storage}), b = setup(t, {storage}); await a.store.adopt(remote()); await b.store.adopt(remote());
  const l = state(); l.profiles[0].bw = 80; a.store.save(l); b.store.storageChanged({key: cacheKey(id)}); await b.store.flush();
  await a.store.flush(); assert.equal(a.calls.length, 0); assert.equal(a.store.dirty, false); assert.equal(a.store.revision, 6);
});

test('workout-only bodyweight edits and deliberately added blank sets are meaningful, unlike initial default rendering', async t => {
  const f = setup(t), r = remote(); r.profile.bw = 80; await f.store.adopt(r);
  const l = clone(f.store.state); l.profiles[0].drafts[1] = newDraft(l.profiles[0]);
  f.store.save(l); assert.equal(f.store.dirty, false);
  l.profiles[0].drafts[1].bwSnapshot = null; f.store.save(l); assert.equal(f.store.dirty, true);
  const blank = state(); blank.profiles[0].drafts[1] = newDraft(blank.profiles[0]); blank.profiles[0].drafts[1].exercises[0].sets.push(blankSet()); assert.equal(sameState(state(), blank), false);
});

test('corrupt shared-tab state and failed reconciliation journals cannot lead to a blind PUT', async t => {
  for (const corrupt of [true, false]) {
    const f = setup(t); await f.store.adopt(remote());
    const other = JSON.parse(f.store.raw); other.dirty = true; other.state.profiles[0].bw = corrupt ? -1 : 90;
    f.storage.setItem(cacheKey(id), JSON.stringify(other));
    if (!corrupt) { const write = f.storage.setItem; f.storage.setItem = (key, value) => { if (key === recoveryKey(id)) throw new Error('quota'); write(key, value); }; }
    const l = state(); l.profiles[0].restSeconds = 180; f.store.save(l); await f.store.flush();
    assert.equal(f.store.locked, true); assert.equal(f.calls.length, 0); assert.equal(JSON.parse(f.storage.getItem(cacheKey(id))).state.profiles[0].bw, corrupt ? -1 : 90);
  }
});
