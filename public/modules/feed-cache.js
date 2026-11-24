export const FEED_CACHE = "hnx-feed-v1";
/** Older copies wait for the network instead of flashing outdated stories. */
export const FEED_REUSE_MS = 60 * 60 * 1000;
const STORED_AT = "x-hnx-stored";

export function isFeedPage(url) {
  return url.pathname === "/api/stories" &&
    /^\?feed=(best|top|new)&offset=(?:0&limit=12|[1-9]\d{0,2}&limit=30)$/.test(url.search);
}

export async function cacheFeedPage(request, response) {
  if (!response.ok || response.redirected || !response.headers.get("content-type")?.includes("application/json")) return;
  try {
    const copy = response.clone();
    const cache = await caches.open(FEED_CACHE);
    const headers = new Headers({ "content-type": "application/json", [STORED_AT]: String(Date.now()) });
    await cache.put(request, new Response(copy.body, { status: copy.status, headers }));
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

export async function readRecentFeedPage(url) {
  const cached = await findFeedPage(url);
  const age = Date.now() - Number(cached?.headers.get(STORED_AT) || NaN);
  if (!(age >= 0 && age < FEED_REUSE_MS)) return null;
  try {
    return await cached.json();
  } catch {
    return null;
  }
}

/** Fresh requests bypass the CDN copy. They still update the stored page. */
export async function requestFeedPage(url, { signal, fresh = false } = {}) {
  if (!navigator.onLine) {
    const cached = await findFeedPage(url);
    if (!cached) throw new Error("This page of the feed has not been loaded yet.");
    return cached;
  }

  const page = new URL(url, location.href);
  const cache = page.searchParams.get("offset") === "0" ? "default" : "no-store";
  const response = await fetch(fresh ? `${url}&fresh=1` : url, { signal, cache, headers: { accept: "application/json" } });
  if (isFeedPage(page)) await cacheFeedPage(url, response);
  return response;
}
