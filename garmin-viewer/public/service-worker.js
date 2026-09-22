// v2: app-shell files are now network-first (see below) instead of
// cache-first. Cache-first meant that once a browser had loaded the app
// once, it would NEVER see a newer deploy again — the service worker only
// re-checks its own script for changes, and none of this file's bytes
// needed to change for the app underneath it to get a major update. Bumping
// this version string forces every existing installed copy to drop its
// stale cache once; going forward, network-first makes that unnecessary.
const CACHE = 'alpine-log-v2';

const SHELL = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/js/api.js',
  '/js/charts.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
];

// Pinned-version third-party libs: these never change without a version
// bump in index.html, so cache-first (fast, works offline) is fine here.
const VENDOR_PREFIX = '/vendor/';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API calls: network-first so data stays fresh, fall back to last cache
  // (lets the dashboard still render something if you go offline).
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Vendor libs: cache-first — pinned versions, safe to serve instantly
  // without a network round-trip.
  if (url.pathname.startsWith(VENDOR_PREFIX)) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((res) => {
            if (res.ok) caches.open(CACHE).then((c) => c.put(event.request, res.clone()));
            return res;
          })
      )
    );
    return;
  }

  // App shell (HTML/CSS/JS this app ships): network-first, so a new deploy
  // is visible on the very next load rather than however long it takes you
  // to remember to clear site data. Falls back to the last cached copy only
  // when there's no network at all.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && event.request.method === 'GET') {
          caches.open(CACHE).then((c) => c.put(event.request, res.clone()));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
