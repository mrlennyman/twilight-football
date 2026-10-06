const CACHE_NAME = 'bb-twilight-shell-v3';
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

// Switching CACHE_NAME also clears every older cache (including any admin pages an
// earlier version of this file stored on the device).
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

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function offlinePage(request, error) {
  const detail = escapeHtml(`${new URL(request.url).pathname} - ${error && error.name}: ${error && error.message}`);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Can't reach the site</title>
<body style="font-family:sans-serif;padding:2rem;max-width:34rem;margin:auto">
<h1>Can't reach the site</h1>
<p>Your phone couldn't connect just now. Check your connection and try again.</p>
<p><a href="" onclick="location.reload();return false" style="display:inline-block;padding:.6rem 1.2rem;background:#6e1b2e;color:#fff;border-radius:2rem;text-decoration:none">Try again</a>
&nbsp; <a href="/">Home</a></p>
<p style="color:#888;font-size:.8rem">${detail}</p>`,
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

// Public pages: always try the live server first (scores must be current); a saved copy is
// only a fallback. The fallback is used ONLY when the network request itself fails.
async function networkFirstPage(request) {
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    const cached = await caches.match(request);
    return cached || offlinePage(request, error);
  }

  // Saving a copy must never be able to turn a good response into an error.
  try {
    if (response.ok && !response.redirected) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
    }
  } catch (ignored) {
    /* ignore */
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== 'GET') return;

  // Admin pages are private and need the live server every time - never intercept or store them.
  if (url.pathname.startsWith('/admin')) return;

  if (isStaticAsset(url)) {
    // Stale-while-revalidate: instant from cache, but always refresh in the
    // background so a deploy reaches phones on their next visit.
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          const refreshed = fetch(request)
            .then((response) => {
              if (response.ok) cache.put(request, response.clone());
              return response;
            })
            .catch(() => cached);
          return cached || refreshed;
        })
      )
    );
    return;
  }

  if (request.mode === 'navigate') event.respondWith(networkFirstPage(request));
});
