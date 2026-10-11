// Offline cache for the Driver Seat app. Bump VERSION when files change.
const VERSION = "driver-v1";
const CORE = [
  "/driver/",
  "/driver/index.html",
  "/driver/manifest.json",
  "/driver/icon-192.png",
  "/driver/icon-512.png",
  "/driver/icon-512-maskable.png",
  "/driver/apple-touch-icon.png",
  "/driver/favicon-32.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith("driver-") && k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Page: network first so updates show up, cache when offline.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then(res => {
        if (res.ok && !res.redirected) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put("/driver/", copy));
        }
        return res;
      }).catch(() => caches.match("/driver/"))
    );
    return;
  }

  // Own files and Google Fonts: cache first, fill cache on miss.
  const ok = url.origin === location.origin
    ? url.pathname.startsWith("/driver/")
    : /^(fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(url.hostname);
  if (!ok) return;
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === "opaque") {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(req, copy));
      }
      return res;
    }))
  );
});
