// App shell cache for the video downloader. Only same-origin GETs under
// /video/ are cached; download requests to the cobalt server pass through.
const CACHE = "video-dl-v1";
const SHELL = ["/video/", "/video/manifest.json", "/video/icon-192.png", "/video/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("video-dl-") && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET" || u.origin !== location.origin || !u.pathname.startsWith("/video/")) return;
  // Pages: network first so updates show up; fall back to the cached shell offline.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put("/video/", copy)); } return r;
    }).catch(() => caches.match("/video/")));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
