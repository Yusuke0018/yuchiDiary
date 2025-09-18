self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  const removeCaches = caches
    .keys()
    .then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key && key.indexOf('yuchi-diary-cache-') === 0) {
            return caches.delete(key);
          }
          return undefined;
        })
      )
    )
    .catch(() => undefined);

  event.waitUntil(
    Promise.resolve(removeCaches)
      .then(() => self.registration.unregister())
      .catch(() => self.registration.unregister())
  );
});
