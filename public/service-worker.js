const CACHE_VERSION = 'yuchi-diary-v2';
const CACHE_NAME = `yuchi-diary-cache-${CACHE_VERSION}`;
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/styles.css',
  '/app-config.js',
  '/scripts/app.js',
  '/firebase-config.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .catch((error) => {
        console.error('SW install error', error);
      })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key.startsWith('yuchi-diary-cache-')) {
            return caches.delete(key);
          }
          return undefined;
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }
  if (!request.url.startsWith(self.location.origin)) {
    return;
  }

  event.respondWith(
    fetch(request).catch((error) => {
      console.warn('SW network fetch failed, attempting cache fallback', error);
      return caches.match(request);
    })
  );
});
