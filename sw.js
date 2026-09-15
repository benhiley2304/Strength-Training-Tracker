/* One coherent release. Bump VERSION whenever any app-shell asset changes. */
const VERSION = "strength-training-tracker-v5-icons-2";
const FILES = ["./", "./index.html", "./styles.css", "./app.js", "./icons.js", "./model.js", "./programme.js", "./manrope-latin.woff2", "./manifest.webmanifest", "./icon.svg", "./icon-maskable.svg"];
const URLS = FILES.map(path => new URL(path, self.registration.scope).href);
const KNOWN = new Set(URLS);
self.addEventListener("install", event => {
  event.waitUntil(caches.open(VERSION).then(async cache => {
    // addAll is atomic: a missing asset prevents the release from installing.
    await cache.addAll(URLS.map(url => new Request(url, {cache: "reload"})));
  }));
  // No skipWaiting here. Open sessions opt in to updates after saving.
});
self.addEventListener("message", event => {
  if (event.data?.type === "ACTIVATE_UPDATE") self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key =>
    key.startsWith("strength-training-tracker-") && key !== VERSION
  ).map(key => caches.delete(key)))));
  // Do not claim uncontrolled clients: their currently loaded assets may be from another release.
});
self.addEventListener("fetch", event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || !KNOWN.has(url.href)) return;
  event.respondWith(caches.open(VERSION).then(async cache => {
    const response = await cache.match(url.href);
    return response || fetch(request); // Never return HTML for an unknown script/image/request.
  }));
});
