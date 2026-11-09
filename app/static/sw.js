// Service worker: makes the app installable and the shell load instantly.
// App shell = network-first (always fresh when online, cached copy when not).
// Fonts / hls.js from CDNs = cache-first. Camera data (/api, /vod) is never cached.
const CACHE = 'frigate-ui-v1';
const SHELL = [
  '/', '/static/style.css', '/static/app.js', '/manifest.webmanifest',
  '/static/icons/icon-192.png', '/static/icons/apple-touch-icon.png', '/static/icons/favicon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    if (/^\/(api|vod|_ui)\//.test(url.pathname)) return; // live data: straight to network
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('/'))),
    );
    return;
  }

  if (/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net/.test(url.hostname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
  }
});
