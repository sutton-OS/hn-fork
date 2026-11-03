import { STORIES_ENDPOINT, ITEM_ENDPOINT, THREAD_ENDPOINT, PAGE_SIZE, COMMENTS_PAGE_SIZE, THREAD_PREFETCH_MAX, THREAD_PREFETCH_TTL_MS } from "./config.js";
import { normalizeFeed, createAbortError } from "./utils.js";

const threadPrefetchCache = new Map();

export async function fetchJSON(
  url,
  { signal, errorPrefix = "Request failed", cache = "default" } = {},
) {
  const response = await fetch(url, { signal, cache });
  if (!response.ok) {
    let message = `${errorPrefix}: ${response.status} (${url})`;
    try {
      const payload = await response.json();
      if (payload?.error) {
        message = `${errorPrefix}: ${payload.error}`;
      }
    } catch {}
    throw new Error(message);
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    const body = await response.text();
    const snippet = body.slice(0, 200);
    throw new Error(
      `${errorPrefix}: non-JSON response (${contentType || "unknown"}): ${snippet}`,
    );
  }

  return response.json();
}

export async function fetchThread(
  id,
  { signal, offset = 0, limit = COMMENTS_PAGE_SIZE } = {},
) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new Error("Invalid story id.");
  }

  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.max(1, Math.min(Number(limit) || COMMENTS_PAGE_SIZE, 80));
  const cacheKey = `${numericId}:${safeOffset}:${safeLimit}`;

  if (signal?.aborted) throw createAbortError();
  const entry = safeOffset === 0 ? threadPrefetchCache.get(cacheKey) : null;
  if (entry) {
    // A prefetch is consumed once. Revisiting a discussion fetches fresh data.
    threadPrefetchCache.delete(cacheKey);
    if (entry.expiresAt > Date.now()) {
      const payload = await awaitWithSignal(entry.promise, signal);
      if (payload) return payload;
    } else {
      entry.controller.abort();
    }
  }

  const params = new URLSearchParams({
    id: String(numericId),
    offset: String(safeOffset),
    limit: String(safeLimit),
  });

  return fetchJSON(`${THREAD_ENDPOINT}?${params.toString()}`, {
    signal,
    cache: "no-store",
    errorPrefix: "Thread request failed",
  });
}

export function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(createAbortError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function prefetchThread(id, { limit = COMMENTS_PAGE_SIZE } = {}) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) return null;
  const cacheKey = `${numericId}:0:${limit}`;
  const cached = threadPrefetchCache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached.promise;
  cached?.controller.abort();

  const controller = new AbortController();
  const entry = {
    controller,
    expiresAt: Date.now() + THREAD_PREFETCH_TTL_MS,
    promise: null,
  };
  entry.promise = fetchJSON(
    `${THREAD_ENDPOINT}?id=${numericId}&offset=0&limit=${limit}`,
    { signal: controller.signal, cache: "no-store", errorPrefix: "Thread prefetch failed" },
  ).catch(() => {
    if (threadPrefetchCache.get(cacheKey) === entry) threadPrefetchCache.delete(cacheKey);
    // Speculative requests must never create an unhandled rejection.
    return null;
  });
  threadPrefetchCache.set(cacheKey, entry);
  while (threadPrefetchCache.size > THREAD_PREFETCH_MAX) {
    const oldest = threadPrefetchCache.keys().next().value;
    threadPrefetchCache.get(oldest).controller.abort();
    threadPrefetchCache.delete(oldest);
  }
  return entry.promise;
}

export function wireDiscussionPrefetch(root) {
  if (!root || root.dataset.prefetchWired === "true") {
    return;
  }
  root.dataset.prefetchWired = "true";

  root.addEventListener(
    "pointerenter",
    (event) => {
      const link = event.target.closest?.(
        "a.meta-time, a[href*='#/item/'], a[href*='#/story/']",
      );
      if (!link || !root.contains(link)) {
        return;
      }
      const href = link.getAttribute("href") || "";
      const match = href.match(/#?\/(?:item|story)\/(\d+)/);
      if (!match) {
        return;
      }
      void prefetchThread(Number(match[1]));
    },
    true,
  );
}

export function normalizeStoriesPage(payload, { offset = 0, limit = PAGE_SIZE } = {}) {
  // New contract: { stories, nextOffset, hasMore, total }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const stories = Array.isArray(payload.stories) ? payload.stories : [];
    const nextOffset = Number(payload.nextOffset);
    const hasMore = Boolean(payload.hasMore);
    return {
      stories,
      nextOffset: Number.isFinite(nextOffset)
        ? nextOffset
        : offset + stories.length,
      hasMore,
      total: Number(payload.total) || 0,
    };
  }

  // Legacy array response fallback.
  const stories = Array.isArray(payload) ? payload : [];
  return {
    stories,
    nextOffset: offset + stories.length,
    hasMore: stories.length >= limit,
    total: 0,
  };
}

export async function getStories(
  feed,
  { signal, offset = 0, limit = PAGE_SIZE } = {},
) {
  const normalizedFeed = normalizeFeed(feed);
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.max(1, Number(limit) || PAGE_SIZE);
  const expectedUrl = `${STORIES_ENDPOINT}?feed=${normalizedFeed}&offset=${safeOffset}&limit=${safeLimit}`;

  // Reuse the head-script prefetch for the first paint only.
  const early = window.__hnxStoriesPrefetch;
  if (early?.promise && early.url === expectedUrl) {
    window.__hnxStoriesPrefetch = null;
    try {
      const payload = await early.promise;
      if (payload) {
        return normalizeStoriesPage(payload, {
          offset: safeOffset,
          limit: safeLimit,
        });
      }
    } catch {
      // fall through to a live fetch
    }
  }

  // Same-origin only — no client-side Firebase fallback (privacy).
  const params = new URLSearchParams({
    feed: normalizedFeed,
    offset: String(safeOffset),
    limit: String(safeLimit),
  });
  const payload = await fetchJSON(`${STORIES_ENDPOINT}?${params.toString()}`, {
    signal,
    cache: "no-store",
    errorPrefix: "Stories request failed",
  });
  return normalizeStoriesPage(payload, { offset: safeOffset, limit: safeLimit });
}

export async function getItem(id, { signal } = {}) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return null;
  }

  return fetchJSON(`${ITEM_ENDPOINT}?id=${numericId}`, {
    signal,
    cache: "no-store",
    errorPrefix: "Item request failed",
  });
}
