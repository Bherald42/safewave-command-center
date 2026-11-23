/* Safewave Command Center — service worker.
   Makes the app installable to the home screen and keeps the shell available.
   Network-first for navigations so teammates always get the latest build;
   falls back to cache when offline. Live data (Firestore) is fetched by the
   page itself and is not cached here. */
const CACHE = 'safewave-shell-v7';
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
  // Static pages outside the app (the training video, the dashboard demo) go straight to the network:
  // not cached as the app shell, and video range requests stay native.
  if (url.pathname.startsWith('/explainer/') || url.pathname.startsWith('/training/') || url.pathname.startsWith('/dashboard-demo/') || url.pathname.startsWith('/watch-sim/')) return;
  if (req.mode === 'navigate') {
    // cache:'no-store' bypasses the HTTP cache entirely — during the OTA-flasher
    // debugging, stale builds kept being served through cache layers even after
    // deploys, and an outdated flasher on real hardware is actively dangerous.
    // Every page load now hits the network for the live build; the cached copy
    // is ONLY the offline fallback.
    // Clone SYNCHRONOUSLY before returning r — otherwise the page starts reading
    // r's body and the later r.clone() throws "Response body is already used".
    e.respondWith(fetch(req, { cache: 'no-store' }).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('/index.html', copy)); return r; }).catch(() => caches.match('/index.html')));
    return;
  }
  e.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});

/* Web push — every Command Center alert is pushed here by the backend
   (functions/index.js → deliverPush). requireInteraction keeps it on screen
   until it's dealt with (desktop/Android); vibrate + renotify make each new
   alert buzz even when an older one is still showing. Whether it can break
   through Do Not Disturb is the phone's setting (allow Safewave in Focus). */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'Safewave';
  const link = /^s-[\w:-]+$/.test(d.link || '') ? d.link : 's-pulse';
  const opts = {
    body: d.body || 'New activity',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    requireInteraction: true,
    vibrate: d.safety ? [600, 150, 600, 150, 600, 150, 900] : [300, 120, 300, 120, 500],
    timestamp: Date.now(),
    data: { link: link, id: d.id || '' },
  };
  if (d.id) { opts.tag = d.id; opts.renotify = true; }
  const badge = (self.navigator && self.navigator.setAppBadge) ? self.navigator.setAppBadge().catch(() => {}) : Promise.resolve();
  e.waitUntil(Promise.all([self.registration.showNotification(title, opts), badge]));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  const link = typeof d === 'string' ? 's-pulse' : (d.link || 's-pulse');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) {
      if ('focus' in c) { c.postMessage({ type: 'sw-goto', link: link, id: d.id || '' }); return c.focus(); }
    }
    return self.clients.openWindow('/?go=' + encodeURIComponent(link) + (d.id ? '&nid=' + encodeURIComponent(d.id) : ''));
  }));
});
