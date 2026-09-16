/* One coherent release. Bump VERSION whenever any app-shell asset changes. */
const VERSION = "strength-training-tracker-v7-history-2";
const FILES = ["./", "./index.html", "./styles.css", "./app.js", "./icons.js", "./cloud.js", "./sync-merge.js", "./history-edit.js", "./cloud-config.js", "./model.js", "./programme.js", "./manrope-latin.woff2", "./manifest.webmanifest", "./icon.svg", "./icon-maskable.svg"];
const URLS = FILES.map(path => new URL(path, self.registration.scope).href);
const KNOWN = new Set(URLS);
self.addEventListener("install", event => {
  event.waitUntil(caches.open(VERSION).then(async cache => {
    // addAll is atomic: a missing asset prevents the release from installing.
    // These allowlisted assets, including index.html, are public and account-free.
    // No config/auth probe: a sleeping API must not delay a returning branded shell.
    // Omit credentials; API responses and cookies never enter this cache.
    await cache.addAll(URLS.map(url => new Request(url, {cache: "reload", credentials: "omit"})));
  }));
  // No skipWaiting here. Open sessions opt in after a durable device snapshot/recovery journal.
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
  // Never cache or intercept auth/API traffic, including error responses.
  if (url.pathname.startsWith("/api/")) return;
  if (request.method !== "GET" || url.origin !== self.location.origin || !KNOWN.has(url.href)) return;
  event.respondWith(caches.open(VERSION).then(async cache => {
    const response = await cache.match(url.href);
    return response || fetch(request); // Never return HTML for an unknown script/image/request.
  }));
});
