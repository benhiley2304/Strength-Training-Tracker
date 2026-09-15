import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
function worker() {
  const handlers = {}, batches = [], handled = [], removed = [], memory = new Map(); let activations = 0;
  const cache = {addAll: async requests => { batches.push(requests); for (const request of requests) memory.set(request.url, {public: true}); }, match: async url => memory.get(url)};
  runInNewContext(sw, {URL, Request, Set, Promise, self: {registration: {scope: 'https://tracker.test/'}, location: {origin: 'https://tracker.test'}, addEventListener: (type, handler) => { handlers[type] = handler; }, skipWaiting: () => activations++},
    caches: {open: async () => cache, keys: async () => ['unrelated-cache', 'strength-training-tracker-old', 'strength-training-tracker-v6-sync-5'], delete: async key => removed.push(key)},
    fetch: async request => { handled.push(request.url); return {network: true}; }
  });
  return {handlers, batches, handled, removed, activations: () => activations};
}
test('service-worker install atomically caches only public shell including HTML, without credentials, API or config probe', async () => {
  const f = worker(); let installed; f.handlers.install({waitUntil: promise => { installed = promise; }}); await installed;
  assert.equal(f.batches.length, 1); const files = f.batches[0];
  assert.ok(files.some(request => request.url === 'https://tracker.test/')); assert.ok(files.some(request => request.url.endsWith('/index.html'))); assert.ok(files.some(request => request.url.endsWith('/sync-merge.js')));
  assert.ok(files.every(request => request.credentials === 'omit' && !request.url.includes('/api/'))); assert.equal(f.handled.length, 0); assert.equal(f.activations(), 0);
});
test('cached public navigation returns immediately without waking network; API/auth and unknown requests are never intercepted', async () => {
  const f = worker(); let promise; f.handlers.install({waitUntil: p => { promise = p; }}); await promise;
  f.handlers.fetch({request: new Request('https://tracker.test/'), respondWith: p => { promise = p; }}); assert.equal((await promise).public, true); assert.equal(f.handled.length, 0);
  for (const url of ['https://tracker.test/api/account', 'https://tracker.test/api/auth/login', 'https://tracker.test/api/config', 'https://tracker.test/unknown', 'https://elsewhere.test/app.js']) {
    let intercepted = false; f.handlers.fetch({request: new Request(url), respondWith: () => { intercepted = true; }}); assert.equal(intercepted, false, url);
  }
});
test('release activation is explicit and removes only older tracker shells', async () => {
  const f = worker(); f.handlers.message({data: {type: 'ACTIVATE_UPDATE'}}); assert.equal(f.activations(), 1);
  let promise; f.handlers.activate({waitUntil: p => { promise = p; }}); await promise;
  assert.deepEqual(f.removed, ['strength-training-tracker-old']);
});
