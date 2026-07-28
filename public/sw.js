// Minimal service worker — required for Chrome/Android PWA install prompt.
// We deliberately do NOT cache pipeline data (it must always be fresh from KV).
// We do cache the shell + Google Fonts so the dashboard opens instantly offline,
// and fall through to network for everything else.

const CACHE = 'josh-shell-v1';
const SHELL = ['/', '/app.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache API calls — pipeline data must be live.
  if (url.pathname.startsWith('/api/')) return;

  // Stale-while-revalidate for the shell.
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
  }
});
