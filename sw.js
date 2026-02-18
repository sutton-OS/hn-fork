const STATIC_CACHE = "hnx-static-v2";
const API_CACHE = "hnx-api-v1";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/app.js",
  "/styles.css",
  "/site.webmanifest",
  "/favicon.png",
  "/favicon-32x32.png",
  "/favicon-16x16.png",
  "/apple-touch-icon.png",
  "/fonts/BerkeleyMono-Regular.otf",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== API_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

function isSameOriginRequest(request) {
  const url = new URL(request.url);
  return url.origin === self.location.origin;
}

function isStaticAssetPath(pathname) {
  if (STATIC_ASSETS.includes(pathname)) {
    return true;
  }

  return (
    pathname.startsWith("/fonts/") ||
    pathname.startsWith("/icons/") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".svg") ||
    pathname.endsWith(".ttf") ||
    pathname.endsWith(".otf")
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || !isSameOriginRequest(request)) {
    return;
  }

  const url = new URL(request.url);

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(API_CACHE);
        const cached = await cache.match(request);

        const networkFetch = fetch(request)
          .then((response) => {
            if (response && response.ok) {
              void cache.put(request, response.clone());
            }
            return response;
          })
          .catch(() => null);

        if (cached) {
          event.waitUntil(networkFetch);
          return cached;
        }

        const networkResponse = await networkFetch;
        return networkResponse || Response.error();
      })(),
    );
    return;
  }

  if (!isStaticAssetPath(url.pathname)) {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match(request);
      if (cached) {
        event.waitUntil(
          fetch(request)
            .then((response) => {
              if (response && response.ok) {
                void cache.put(request, response.clone());
              }
            })
            .catch(() => {}),
        );
        return cached;
      }

      const response = await fetch(request);
      if (response && response.ok) {
        void cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});
