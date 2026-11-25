import { FEED_SAVED, STORIES_ENDPOINT } from "./config.js";
import { normalizeFeed } from "./utils.js";

export const FEED_CACHE = "hnx-feed-v1";
/** Wall Street Journal headlines. Not a Hacker News feed, so it has no scores or discussions. */
export const FEED_WSJ = "wsj";
export const FEED_WSJ_TOP = "wsj-top";
/** Older copies wait for the network instead of flashing outdated stories. */
export const FEED_REUSE_MS = 60 * 60 * 1000;
const STORED_AT = "x-hnx-stored";

/** A tab name the app can show, or the default feed. */
export function normalizeTab(feed) {
  return feed === FEED_SAVED || isWsjFeed(feed) ? feed : normalizeFeed(feed);
}

export function isWsjFeed(feed) {
  return feed === FEED_WSJ || feed === FEED_WSJ_TOP;
}

/** Both WSJ lists share one tab. */
export function tabId(feed) {
  return `feed-tab-${isWsjFeed(feed) ? FEED_WSJ : feed}`;
}

export function feedPageUrl(feed, offset, limit) {
  return `${STORIES_ENDPOINT}?feed=${isWsjFeed(feed) ? feed : normalizeFeed(feed)}&offset=${offset}&limit=${limit}`;
}

export function isFeedPage(url) {
  return url.pathname === STORIES_ENDPOINT &&
    /^\?feed=(?:best|top|new|wsj(?:-top)?)&offset=(?:0&limit=12|[1-9]\d{0,2}&limit=30)$/.test(url.search);
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
