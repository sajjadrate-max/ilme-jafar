// sw.js — مریضوں کا کھاتہ: آف لائن کھلنے اور انسٹال کے لیے
const CACHE_NAME = 'mareez-khata-v1';
const SCOPE = '/mareez-khata/';
const ASSETS = [SCOPE, SCOPE + 'index.html', SCOPE + 'manifest.json', SCOPE + 'khata-icon-192.png', SCOPE + 'khata-icon-512.png', SCOPE + 'khata-icon-512-maskable.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE_NAME).map(x => caches.delete(x))))); self.clients.claim(); });
// صفحہ: پہلے نیٹ، نہ ملے تو کیش — باقی فائلیں: پہلے کیش
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const page = e.request.mode === 'navigate';
  e.respondWith(page
    ? fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE_NAME).then(x => x.put(SCOPE, c)); return r; }).catch(() => caches.match(SCOPE))
    : caches.match(e.request).then(r => r || fetch(e.request)));
});
