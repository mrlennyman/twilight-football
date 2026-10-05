const CACHE_NAME = 'bb-twilight-shell-v2';
const APP_SHELL = [
  '/css/style.css',
  '/css/print.css',
  '/manifest.json',
  '/img/logo.svg',
  '/icons/favicon-32.png',
  '/icons/apple-touch-icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

const isStaticAsset = (url) =>
  url.pathname.startsWith('/css/') ||
  url.pathname.startsWith('/icons/') ||
  url.pathname.startsWith('/img/') ||
  url.pathname.startsWith('/js/');

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;

  if (isStaticAsset(url)) {
    // Stale-while-revalidate: instant from cache, but always refresh in the
    // background so a deploy reaches phones on their next visit (a pure
    // cache-first strategy would pin old CSS forever).
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(event.request).then((cached) => {
          const refreshed = fetch(event.request)
            .then((response) => {
              if (response.ok) cache.put(event.request, response.clone());
              return response;
            })
            .catch(() => cached);
          return cached || refreshed;
        })
      )
    );
    return;
  }

  // Network-first for everything else (pages, data): fixtures/results/standings
  // must never be served stale. Cache is only a fallback if the network is down.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() =>
        caches.match(event.request).then(
          (cached) =>
            cached ||
            new Response(
              '<!doctype html><meta charset="utf-8"><title>Offline</title><body style="font-family:sans-serif;padding:2rem"><h1>You\'re offline</h1><p>Check your connection and try again.</p>',
              { headers: { 'Content-Type': 'text/html' } }
            )
        )
      )
  );
});
