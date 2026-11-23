import { FEED_CACHE, cacheFeedPage, findFeedPage, isFeedPage } from "./modules/feed-cache.js";

const STATIC_CACHE = "shell-v1";
const STATIC_ASSETS = [
  "/index.html",
  "/app.js?v=37",
  "/prefetch.js?v=37",
  "/theme-init.js?v=36",
  "/styles.css?v=37",
  "/privacy.html",
  "/site.webmanifest?v=4",
  "/favicon.png",
  "/favicon-32x32.png?v=2",
  "/favicon-16x16.png?v=2",
  "/apple-touch-icon.png?v=2",
  "/android-chrome-192x192.png",
  "/android-chrome-512x512.png",
  "/fonts/Geist-1.9.2-Variable.woff2",
  "/fonts/GeistMono-1.9.2-Variable.woff2",
  "/vendor/dompurify-3.5.0.es.mjs",
  "/modules/api.js?v=37",
  "/modules/comments.js?v=37",
  "/modules/config.js",
  "/modules/feed-cache.js",
  "/modules/feed.js?v=37",
  "/modules/routing.js",
  "/modules/sanitize.js?v=37",
  "/modules/saved-store.js",
  "/modules/saved-view.js",
  "/modules/saved.js",
  "/modules/story.js?v=37",
  "/modules/ui.js?v=37",
  "/modules/utils.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) =>
      /^(?:shell-v|hnx-static-v|hnx-api-v|hnx-feed-v)\d+$/.test(key) &&
      key !== STATIC_CACHE && key !== FEED_CACHE,
    ).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function networkFirstNavigation(request) {
  try {
    return await fetch(request, { cache: "no-cache" });
  } catch {
    const cache = await caches.open(STATIC_CACHE);
    return (await cache.match(request)) || (await cache.match("/index.html")) || Response.error();
  }
}

function staleWhileRevalidateFeed(event) {
  const { request } = event;
  const update = fetch(request).then(async (response) => {
    if (!response.redirected) await cacheFeedPage(request, response);
    return response;
  }).catch(() => Response.error());
  event.waitUntil(update.then(() => {}));
  return findFeedPage(request).then((cached) => cached || update);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (isFeedPage(url)) {
    event.respondWith(staleWhileRevalidateFeed(event));
  } else if (url.pathname.startsWith("/api/")) {
    return;
  } else if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
  } else if (STATIC_ASSETS.includes(url.pathname + url.search)) {
    event.respondWith(caches.match(request, { cacheName: STATIC_CACHE }).then((cached) => cached || fetch(request)));
  }
});
