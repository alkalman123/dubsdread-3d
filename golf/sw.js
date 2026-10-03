/* Offline support.
 *
 * Network first, always: a new version of the game is picked up the moment it
 * is published, with no stale mix of old and new files. Every file that comes
 * back is also kept, so when there is no network — on a course, on a plane —
 * the app opens from what it last saw. A course you have played once is
 * playable offline after that.
 */
const CACHE = 'dubsdread-v1';
const SHELL = ['./', 'index.html', 'play.html', 'flat.html', 'manifest.json', 'courses/index.js',
               'icon-192.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })
      .then(r => r || (req.mode === 'navigate' ? caches.match('index.html') : undefined))
      .then(r => r || new Response('Offline', { status: 503 })))
  );
});
