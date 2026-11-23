export const FEED_CACHE = "hnx-feed-v1";

export function isFeedPage(url) {
  return url.pathname === "/api/stories" &&
    /^\?feed=(best|top|new)&offset=(?:0&limit=12|[1-9]\d{0,2}&limit=30)$/.test(url.search);
}

export async function cacheFeedPage(request, response) {
  if (!response.ok || response.redirected || !response.headers.get("content-type")?.includes("application/json")) return;
  try {
    const copy = response.clone();
    const cache = await caches.open(FEED_CACHE);
    await cache.put(request, copy);
  } catch {
    // The feed still works if Cache Storage is unavailable.
  }
}

export async function findFeedPage(request) {
  try {
    return await caches.match(request, { cacheName: FEED_CACHE, ignoreVary: true });
  } catch {
    return undefined;
  }
}

export async function requestFeedPage(url, { signal } = {}) {
  if (!navigator.onLine) {
    const cached = await findFeedPage(url);
    if (!cached) throw new Error("This page of the feed has not been loaded yet.");
    return cached;
  }

  const page = new URL(url, location.href);
  const cache = page.searchParams.get("offset") === "0" ? "default" : "no-store";
  const response = await fetch(url, { signal, cache, headers: { accept: "application/json" } });
  if (isFeedPage(page)) await cacheFeedPage(url, response);
  return response;
}
