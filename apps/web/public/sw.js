self.addEventListener("install", function (event) {
  self.skipWaiting();
  event.waitUntil(clearAllCaches());
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    clearAllCaches()
      .then(function () {
        return self.clients.claim();
      })
      .then(function () {
        return self.registration.unregister();
      })
      .then(function () {
        return self.clients.matchAll({ type: "window", includeUncontrolled: true });
      })
      .then(function (clients) {
        return Promise.all(
          clients.map(function (client) {
            if (!client.url) return undefined;
            return client.navigate(client.url).catch(function () {
              return undefined;
            });
          }),
        );
      }),
  );
});

function clearAllCaches() {
  if (!self.caches) return Promise.resolve();
  return self.caches.keys().then(function (names) {
    return Promise.all(
      names.map(function (name) {
        return self.caches.delete(name);
      }),
    );
  });
}
