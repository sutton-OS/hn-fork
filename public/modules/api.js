import { STORIES_ENDPOINT, ITEM_ENDPOINT, THREAD_ENDPOINT, PAGE_SIZE, COMMENTS_PAGE_SIZE, THREAD_PREFETCH_MAX, THREAD_PREFETCH_TTL_MS } from "./config.js";
import { normalizeFeed, createAbortError } from "./utils.js";
import { requestFeedPage, readRecentFeedPage } from "./feed-cache.js?v=43";

const threadPrefetchCache = new Map();
const inflightPrefetches = new Set();
const DISCUSSION_HOVER_DELAY_MS = 150;
const MAX_INFLIGHT_PREFETCHES = 2;

async function fetchResponse(
  url,
  { signal, errorPrefix = "Request failed", cache = "default", accept = "application/json" } = {},
) {
  const response = await fetch(url, { signal, cache, headers: { accept } });
  return requireOK(response, url, errorPrefix);
}

async function requireOK(response, url, errorPrefix) {
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
  return response;
}

export async function fetchJSON(url, options = {}) {
  const { errorPrefix = "Request failed" } = options;
  return readJSON(await fetchResponse(url, options), errorPrefix);
}

async function readJSON(response, errorPrefix) {
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
  if (signal?.aborted) throw createAbortError();
  const entry = safeOffset === 0 ? takeThreadPrefetch(numericId, safeLimit) : null;
  if (entry) {
    const payload = await consumeThreadPrefetch(entry, signal);
    if (payload) return payload;
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

function takeThreadPrefetch(id, limit) {
  const key = `${id}:0:${limit}`;
  const entry = threadPrefetchCache.get(key);
  if (!entry) return null;
  // A prefetch is consumed once. Revisits request a fresh thread.
  threadPrefetchCache.delete(key);
  if (entry.expiresAt > Date.now()) return entry;
  entry.controller.abort();
  return null;
}

async function consumeThreadPrefetch(entry, signal) {
  const abort = () => entry.controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await awaitWithSignal(entry.promise, signal);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export function startDiscussion(id, { signal } = {}) {
  if (signal?.aborted) throw createAbortError();
  const entry = takeThreadPrefetch(id, COMMENTS_PAGE_SIZE);
  if (entry) {
    // Prefetches are snapshots. Read the current title and story text at navigation.
    const thread = consumeThreadPrefetch(entry, signal)
      .then((payload) => payload || fetchThread(id, { signal }));
    void thread.catch(() => {});
    const parent = getItem(id, { signal }).catch(() => null)
      .then((item) => item || thread.catch(() => null));
    return { parent, thread };
  }

  let settleParent;
  const parent = new Promise((resolve) => { settleParent = resolve; });
  const thread = readDiscussionStream(id, signal, settleParent)
    .finally(() => settleParent(null));
  // The discussion module may still be loading when this request finishes.
  void thread.catch(() => {});
  return { parent, thread };
}

async function readDiscussionStream(id, signal, onParent) {
  const params = new URLSearchParams({
    id: String(id), offset: "0", limit: String(COMMENTS_PAGE_SIZE), stream: "1",
  });
  const response = await fetchResponse(`${THREAD_ENDPOINT}?${params}`, {
    signal,
    cache: "no-store",
    errorPrefix: "Thread request failed",
    accept: "application/x-ndjson, application/json",
  });

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const thread = await response.json();
    onParent(thread);
    return thread;
  }
  if (!contentType.includes("application/x-ndjson") || !response.body) {
    throw new Error("Thread request failed: unexpected response format.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const lines = (buffer + decoder.decode(value, { stream: true })).split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const packet = JSON.parse(line);
        if (packet.parent) onParent(packet.parent);
        if (packet.error) throw new Error(packet.error);
        if (packet.thread) return packet.thread;
      }
    }
    throw new Error("Thread request failed: incomplete response.");
  } finally {
    await reader.cancel().catch(() => {});
  }
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
  if (inflightPrefetches.size >= MAX_INFLIGHT_PREFETCHES) return null;

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
  }).finally(() => inflightPrefetches.delete(entry));
  inflightPrefetches.add(entry);
  threadPrefetchCache.set(cacheKey, entry);
  while (threadPrefetchCache.size > THREAD_PREFETCH_MAX) {
    const oldest = threadPrefetchCache.keys().next().value;
    threadPrefetchCache.get(oldest).controller.abort();
    threadPrefetchCache.delete(oldest);
  }
  return entry.promise;
}

export function wireDiscussionPrefetch(root, onDiscussionIntent) {
  if (!root || root.dataset.prefetchWired === "true") {
    return;
  }
  root.dataset.prefetchWired = "true";

  const selector = "a[href^='#/item/'], a[href^='#/story/'], button[data-action='load-replies']:not([data-loaded])";
  let target = null;
  let timer;
  let cancelPrefetch = null;

  function reset() {
    clearTimeout(timer);
    cancelPrefetch?.();
    cancelPrefetch = null;
    target = null;
  }

  function targetId(element) {
    if (element.dataset.action) return Number(element.dataset.commentId);
    const match = (element.getAttribute("href") || "").match(/^#\/(?:item|story)\/(\d+)$/);
    return match ? Number(match[1]) : 0;
  }

  function start(element, id) {
    if (!root.contains(element)) return;
    if (!element.dataset.action) onDiscussionIntent?.();
    const key = `${id}:0:${COMMENTS_PAGE_SIZE}`;
    prefetchThread(id);
    const entry = threadPrefetchCache.get(key);
    cancelPrefetch = () => {
      if (threadPrefetchCache.get(key) === entry && inflightPrefetches.has(entry)) {
        threadPrefetchCache.delete(key);
        entry.controller.abort();
      }
    };
  }

  root.addEventListener("pointerover", (event) => {
    if (!navigator.onLine) return;
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    const element = event.target.closest?.(selector);
    if (!element || element === target || !root.contains(element)) return;
    const id = targetId(element);
    if (!id) return;
    reset();
    target = element;
    timer = setTimeout(() => start(element, id), DISCUSSION_HOVER_DELAY_MS);
  });

  // A press is enough intent. The request gets a head start on the click.
  root.addEventListener("pointerdown", (event) => {
    if (!navigator.onLine || !event.isPrimary || event.button !== 0) return;
    const element = event.target.closest?.(selector);
    if (!element || !root.contains(element)) return;
    const id = targetId(element);
    if (!id) return;
    if (element !== target) reset();
    clearTimeout(timer);
    target = element;
    start(element, id);
  }, { passive: true });

  root.addEventListener("pointerout", (event) => {
    // A touch pointer leaves before its click. Only a cancelled touch, such as a scroll, resets it.
    if (event.pointerType === "touch") return;
    if (target?.contains(event.target) && !target.contains(event.relatedTarget)) {
      reset();
    }
  });
  root.addEventListener("pointercancel", reset);
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

/** Last stored first page, when it is recent enough to show before the network. */
export async function getRecentStories(feed, { limit = PAGE_SIZE } = {}) {
  const url = `${STORIES_ENDPOINT}?feed=${normalizeFeed(feed)}&offset=0&limit=${limit}`;
  const payload = await readRecentFeedPage(url);
  return payload ? normalizeStoriesPage(payload, { offset: 0, limit }) : null;
}

export async function getStories(
  feed,
  { signal, offset = 0, limit = PAGE_SIZE, fresh = false } = {},
) {
  const normalizedFeed = normalizeFeed(feed);
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.max(1, Number(limit) || PAGE_SIZE);
  const expectedUrl = `${STORIES_ENDPOINT}?feed=${normalizedFeed}&offset=${safeOffset}&limit=${safeLimit}`;

  // Reuse the head-script prefetch for the first paint only.
  const early = window.__hnxStoriesPrefetch;
  if (!fresh && early?.promise && early.url === expectedUrl) {
    window.__hnxStoriesPrefetch = null;
    const payload = await awaitWithSignal(early.promise, signal);
    if (payload) {
      return normalizeStoriesPage(payload, { offset: safeOffset, limit: safeLimit });
    }
  }

  const response = await requestFeedPage(expectedUrl, { signal, fresh });
  const errorPrefix = "Stories request failed";
  const payload = await readJSON(await requireOK(response, expectedUrl, errorPrefix), errorPrefix);
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
