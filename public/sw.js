importScripts("/modules/alert-device.js");

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
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
