const STATIC_CACHE = "hnx-static-v16";
const API_CACHE = "hnx-api-v4";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/app.js",
  "/prefetch.js",
  "/styles.css",
  "/privacy.html",
  "/site.webmanifest",
  "/favicon.png",
  "/favicon-32x32.png",
  "/favicon-16x16.png",
  "/apple-touch-icon.png",
  "/android-chrome-192x192.png",
  "/android-chrome-512x512.png",
  "/fonts/BerkeleyMono-Regular.woff2",
  "/fonts/Poppins-Regular.woff2",
  "/fonts/Poppins-Regular-LatinExt.woff2",
  "/vendor/dompurify.es.mjs",
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
    pathname.endsWith(".png") ||
    pathname.endsWith(".woff2")
  );
}

function isAppShellRequest(request, pathname) {
  return (
    request.mode === "navigate" ||
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname === "/app.js" ||
    pathname === "/styles.css"
  );
}

function isStoriesApi(pathname) {
  return pathname === "/api/stories";
}

async function staleWhileRevalidateApi(request) {
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok && request.cache !== "no-store") {
        void cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // Kick network update; return stale immediately for snappy list loads.
    void networkPromise;
    return cached;
  }

  const network = await networkPromise;
  return network || Response.error();
}

async function networkFirstApi(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok && request.cache !== "no-store") {
      void cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || !isSameOriginRequest(request)) {
    return;
  }

  const url = new URL(request.url);

  if (url.pathname.startsWith("/api/")) {
    // Bypass SW cache entirely for forced refreshes.
    if (request.cache === "no-store" || url.searchParams.has("refresh")) {
      event.respondWith(fetch(request));
      return;
    }

    if (isStoriesApi(url.pathname)) {
      event.respondWith(staleWhileRevalidateApi(request));
      return;
    }

    event.respondWith(networkFirstApi(request));
    return;
  }

  if (!isStaticAssetPath(url.pathname)) {
    return;
  }

  if (isAppShellRequest(request, url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);

        try {
          const response = await fetch(request);
          if (response && response.ok) {
            void cache.put(request, response.clone());
          }
          return response;
        } catch {
          const cached =
            (await cache.match(request)) ||
            (request.mode === "navigate" ? await cache.match("/") : null);
          return cached || Response.error();
        }
      })(),
    );
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
