// sw.js — offline support.
// App shell: cache-first, installed up front.
// Everything else (Leaflet CDN, map tiles): cache-first with network fallback,
// so anything viewed once while online becomes available offline afterward.

const SHELL_CACHE = 'survey-logger-shell-v6';
const RUNTIME_CACHE = 'survey-logger-runtime-v1';

const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './db.js',
  './gps.js',
  './app.js',
  './ui.js',
  './main.js',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
