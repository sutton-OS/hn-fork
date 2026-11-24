import "./modules/alert-device.js";
import { FEED_CACHE } from "./modules/feed-cache.js";

const STATIC_CACHE = "shell-v7";
const STATIC_ASSETS = [
  "/index.html",
  "/app.js?v=44",
  "/prefetch.js?v=43",
  "/theme-init.js?v=41",
  "/styles.css?v=45",
  "/privacy.html",
  "/manifest.webmanifest",
  "/maskable-512x512.png",
  "/favicon.png",
  "/favicon-32x32.png?v=2",
  "/favicon-16x16.png?v=2",
  "/apple-touch-icon.png?v=2",
  "/android-chrome-192x192.png",
  "/android-chrome-512x512.png",
  "/fonts/Geist-1.9.2-Variable.woff2",
  "/fonts/GeistMono-1.9.2-Variable.woff2",
  "/vendor/dompurify-3.5.0.es.mjs",
  "/modules/alert-device.js",
  "/modules/alert-rules.js",
  "/modules/alerts.js",
  "/modules/api.js?v=43",
  "/modules/comments.js?v=43",
  "/modules/config.js",
  "/modules/feed-cache.js?v=43",
  "/modules/feed.js?v=44",
  "/modules/preview-entry.js",
  "/modules/preview.js",
  "/modules/pwa.js",
  "/modules/routing.js",
  "/modules/sanitize.js?v=41",
  "/modules/saved-store.js",
  "/modules/saved-view.js",
  "/modules/saved.js",
  "/modules/sheet.js",
  "/modules/story.js?v=43",
  "/modules/ui.js?v=41",
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

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
  } else if (STATIC_ASSETS.includes(url.pathname + url.search)) {
    event.respondWith(caches.match(request, { cacheName: STATIC_CACHE }).then((cached) => cached || fetch(request)));
  }
});

const alerts = self.hnxAlertDevice;

function storyId(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 999999999999 ? value : null;
}

self.addEventListener("push", (event) => {
  let payload;
  try { payload = event.data?.json(); } catch {}
  const id = storyId(payload?.id);
  const title = typeof payload?.title === "string" && payload.title.trim()
    ? Array.from(payload.title).slice(0, 100).join("") : "HNx alerts";
  const metadata = Number.isFinite(payload?.points) && Number.isFinite(payload?.comments) &&
    typeof payload?.domain === "string";
  const body = metadata ? `${payload.points} pts, ${payload.comments} comments, ${payload.domain}` :
    typeof payload?.body === "string" ? payload.body.slice(0, 200) : "Open HNx to check your alerts.";
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body,
      icon: "/android-chrome-192x192.png",
      tag: id ? String(id) : payload?.tag === "hnx-alert-summary" ? payload.tag : "hnx-alert",
      data: { id, url: payload?.url ?? null, hnUrl: payload?.hnUrl ?? null },
    }),
    alerts.badge(true).catch(() => {}),
  ]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = storyId(event.notification.data?.id);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      const url = new URL(client.url);
      if (url.origin !== self.location.origin || !["/", "/index.html"].includes(url.pathname)) continue;
      try {
        const focused = await client.focus();
        if (!focused) continue;
        if (id) focused.postMessage({ type: "open-story", id });
        return;
      } catch { /* The window may have closed. */ }
    }
    await self.clients.openWindow(id ? "/?story=" + id : "/");
  })());
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(alerts.exclusive("subscription", () =>
    alerts.synchronize(self.registration, { replacement: event.newSubscription })).catch(() => {
    // A later app open can retry when both storage and the network are available.
  }));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "clear-alert-badge") event.waitUntil(alerts.badge(false).catch(() => {}));
});
