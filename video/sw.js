// App shell cache for the video downloader. Only same-origin GETs inside this
// app's folder are cached; API calls and downloads always go to the network.
const CACHE = "video-dl-v6";
const BASE = new URL("./", self.location).pathname;
const SHELL = [BASE, BASE + "manifest.json", BASE + "icon-192.png", BASE + "icon-512.png"];

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
  if (req.method !== "GET" || u.origin !== location.origin || !u.pathname.startsWith(BASE)) return;
  // Pages: network first so updates show up; fall back to the cached shell offline.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(BASE, copy)); }
      return r;
    }).catch(() => caches.match(BASE)));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
