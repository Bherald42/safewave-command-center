/* Safewave Command Center — service worker.
   Makes the app installable to the home screen and keeps the shell available.
   Network-first for navigations so teammates always get the latest build;
   falls back to cache when offline. Live data (Firestore) is fetched by the
   page itself and is not cached here. */
const CACHE = 'safewave-shell-v2';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only handle same-origin; let Firebase/CDN/Shopify requests pass straight through.
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // Clone SYNCHRONOUSLY before returning r — otherwise the page starts reading
    // r's body and the later r.clone() throws "Response body is already used".
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('/index.html', copy)); return r; }).catch(() => caches.match('/index.html')));
    return;
  }
  e.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});

/* Web push — payload arrives from the backend once FCM/Shopify webhook are wired. */
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  const title = data.title || 'Safewave';
  const body = data.body || 'New activity';
  e.waitUntil(self.registration.showNotification(title, { body, icon: '/icon-192.png', badge: '/icon-192.png', data: data.url || '/' }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => { for (const c of cs) { if ('focus' in c) return c.focus(); } return self.clients.openWindow(e.notification.data || '/'); }));
});
