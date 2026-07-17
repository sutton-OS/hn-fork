import DOMPurify from "./vendor/dompurify.es.mjs";

const STORIES_ENDPOINT = "/api/stories";
const ITEM_ENDPOINT = "/api/item";
const THREAD_ENDPOINT = "/api/thread";
const PAGE_SIZE = 30;
const INITIAL_PAGE_SIZE = 12;
/** Direct replies fetched per expand / root page (server-side page size). */
const COMMENTS_PAGE_SIZE = 40;
/** DOM nodes mounted per animation frame within a page. */
const COMMENTS_DOM_BATCH = 20;
/** Visual indent cap — deeper threads stay readable. */
const MAX_COMMENT_DEPTH = 6;
/** px — clamp long comment bodies past this height. */
const COMMENT_CLAMP_PX = 168;
const FEED_BEST = "best";
const FEED_TOP = "top";
const FEED_NEW = "new";
const FEEDS = [FEED_BEST, FEED_TOP, FEED_NEW];
const LIST_VISIBLE_REFRESH_AFTER_MS = 60 * 1000;
const THREAD_PREFETCH_MAX = 24;
const SANITIZE_ALLOWED_TAGS = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "em",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "ul",
];
const app = document.getElementById("app");
app?.classList.add("shell");

const unescape = document.createElement("textarea");
let currentViewController = null;
let selectedStoryIndex = -1;
let listKeyboardHandler = null;
let storyKeyboardHandler = null;
let selectedCommentIndex = -1;
let currentFeed = FEED_BEST;
let listHiddenAt = 0;
const commentActionHandlers = new WeakMap();
/** @type {Map<string, Promise<unknown>>} */
const threadPrefetchCache = new Map();

// Always start dark; theme/feed are session-only (not persisted).
applyTheme("dark");
window.addEventListener("hashchange", handleRouteChange);
window.addEventListener("pageshow", handlePageShow);
document.addEventListener("visibilitychange", handleVisibilityChange);
// Don't wait for window "load" (fonts/images) — modules already run after DOM parse.
void handleRouteChange();

function handlePageShow(event) {
  if (event.persisted) {
    refreshCurrentList();
  }
}

function handleVisibilityChange() {
  if (document.hidden) {
    listHiddenAt = Date.now();
    return;
  }

  if (
    listHiddenAt > 0 &&
    Date.now() - listHiddenAt >= LIST_VISIBLE_REFRESH_AFTER_MS
  ) {
    refreshCurrentList();
  }
  listHiddenAt = 0;
}

function refreshCurrentList() {
  if (app.dataset.view !== "list") {
    return;
  }
  void renderRoute({ type: "list" });
}

async function handleRouteChange() {
  const route = parseRoute();

  if (canHandleRouteInPlace(route)) {
    return;
  }

  await renderRoute(route);
}

async function renderRoute(route = parseRoute()) {
  abortCurrentViewLoad();
  teardownListSelection();
  app.dataset.view = "";
  app.innerHTML = "";

  if (route.type === "story") {
    await renderStoryPage(route.id);
    return;
  }

  await renderListPage();
}

function canHandleRouteInPlace(route) {
  return app.dataset.view === "list" && route.type === "list";
}

function parseRoute() {
  const hash = window.location.hash.replace(/^#/, "").trim();

  if (!hash || hash === "/") {
    return { type: "list" };
  }

  const pageMatch = hash.match(/^\/page\/(\d+)$/);
  if (pageMatch) {
    return { type: "list" };
  }

  const storyMatch = hash.match(/^\/(?:item|story)\/(\d+)$/);
  if (storyMatch) {
    return { type: "story", id: Number(storyMatch[1]) };
  }

  const queryStoryMatch = hash.match(/^\/item\?id=(\d+)$/);
  if (queryStoryMatch) {
    return { type: "story", id: Number(queryStoryMatch[1]) };
  }

  return { type: "list" };
}

function escapeHTML(value) {
  unescape.textContent = value ?? "";
  return unescape.innerHTML;
}

function normalizeFeed(feed) {
  return FEEDS.includes(feed) ? feed : FEED_BEST;
}

function updateThemeToggle() {
  const isDark = document.documentElement.dataset.theme === "dark";
  app.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    button.setAttribute("aria-checked", isDark ? "true" : "false");
    button.setAttribute("aria-label", isDark ? "Use light mode" : "Use dark mode");
  });
}

function applyTheme(theme) {
  const nextTheme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = nextTheme;
  document.documentElement.style.colorScheme = nextTheme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", nextTheme === "dark" ? "#111111" : "#f3efe8");
  updateThemeToggle();
}

function wireThemeToggle(root = app) {
  root.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    if (button.dataset.themeWired) {
      return;
    }
    button.dataset.themeWired = "true";
    button.addEventListener("click", () => {
      const nextTheme =
        document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(nextTheme);
    });
  });
  updateThemeToggle();
}

function getFeedLabel(feed = currentFeed) {
  const normalized = normalizeFeed(feed);
  if (normalized === FEED_TOP) {
    return "Top";
  }
  if (normalized === FEED_NEW) {
    return "New";
  }
  return "Best";
}

function getFeedPickerButton(feed) {
  const normalized = normalizeFeed(feed);
  const isActive = normalized === currentFeed;
  return `
    <button
      class="btn feed-option${isActive ? " is-active" : ""}"
      type="button"
      data-feed-option="${normalized}"
      aria-pressed="${isActive ? "true" : "false"}"
      aria-label="Feed: ${getFeedLabel(normalized)}"
    >
      <span class="feed-option-label">${getFeedLabel(normalized)}</span>
    </button>
  `;
}

function updateFeedToggleLabels() {
  const normalized = normalizeFeed(currentFeed);
  app.querySelectorAll("[data-feed-picker]").forEach((picker) => {
    picker.querySelectorAll("[data-feed-option]").forEach((button) => {
      const optionFeed = normalizeFeed(button.getAttribute("data-feed-option"));
      const isActive = optionFeed === normalized;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  });
}

function applyFeed(feed, { rerender = false } = {}) {
  currentFeed = normalizeFeed(feed);
  updateFeedToggleLabels();
  if (rerender) {
    rerenderListForFeedChange();
  }
}

function rerenderListForFeedChange() {
  if (app.dataset.view !== "list") {
    return;
  }
  const hash = window.location.hash.replace(/^#/, "").trim();
  if (hash && hash !== "/") {
    window.location.hash = "/";
  }
  void renderRoute({ type: "list" });
}

function wireFeedToggleButtons(root = app) {
  root.querySelectorAll("[data-feed-option]").forEach((button) => {
    if (button.dataset.feedWired) {
      return;
    }
    button.dataset.feedWired = "true";
    button.addEventListener("click", () => {
      const next = button.getAttribute("data-feed-option");
      applyFeed(next, { rerender: true });
    });
  });
  updateFeedToggleLabels();
}

function createAbortError() {
  return new DOMException("Aborted", "AbortError");
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function abortCurrentViewLoad() {
  if (currentViewController) {
    currentViewController.abort();
    currentViewController = null;
  }
  teardownStoryKeyboard();
}

function navigateTo(pathname) {
  if (!pathname) {
    return;
  }

  const normalizedPath = pathname.startsWith("#")
    ? pathname.slice(1)
    : pathname.startsWith("/")
      ? pathname
      : `/${pathname}`;

  window.location.hash = normalizedPath;
}

function setSelectedStoryElement(storyEl, { scroll = false } = {}) {
  if (!storyEl) {
    return;
  }
  const stories = getListStoryElements();
  const nextIndex = stories.indexOf(storyEl);
  if (nextIndex < 0) {
    return;
  }
  selectedStoryIndex = nextIndex;
  applyListSelection({ scroll });
}

function getListStoryElements() {
  return Array.from(app.querySelectorAll(".story-list .story"));
}

function clampSelectedStoryIndex(stories) {
  if (!stories.length) {
    selectedStoryIndex = -1;
    return;
  }

  if (selectedStoryIndex < 0) {
    selectedStoryIndex = 0;
    return;
  }

  if (selectedStoryIndex >= stories.length) {
    selectedStoryIndex = stories.length - 1;
  }
}

function applyListSelection({ scroll = false } = {}) {
  const stories = getListStoryElements();
  if (!stories.length) {
    selectedStoryIndex = -1;
    return;
  }

  clampSelectedStoryIndex(stories);

  stories.forEach((story, index) => {
    story.classList.toggle("is-selected", index === selectedStoryIndex);
  });

  if (scroll && selectedStoryIndex >= 0) {
    stories[selectedStoryIndex].scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }
}

function selectStoryIndex(nextIndex, { scroll = true } = {}) {
  const stories = getListStoryElements();
  if (!stories.length) {
    selectedStoryIndex = -1;
    return;
  }

  const clamped = Math.max(0, Math.min(nextIndex, stories.length - 1));
  selectedStoryIndex = clamped;
  applyListSelection({ scroll });
}

function getSelectedStoryLink() {
  const stories = getListStoryElements();
  if (!stories.length) {
    return null;
  }

  clampSelectedStoryIndex(stories);
  const selectedStory = stories[selectedStoryIndex];
  if (!selectedStory) {
    return null;
  }

  return selectedStory.querySelector(".story-title a");
}

function getStoryNavigationPath(link) {
  if (!link) {
    return "";
  }

  const href = link.getAttribute("href") || "";
  if (!href) {
    return "";
  }

  if (href.startsWith("#/")) {
    return href.slice(1);
  }

  if (href.startsWith("/")) {
    return href;
  }

  try {
    const parsed = new URL(href, window.location.href);
    if (parsed.origin === window.location.origin) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {}

  return "";
}

function isModifiedClick(event) {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }

  if (target.closest("input, textarea, select, button")) {
    return true;
  }

  return target.closest('[contenteditable=""], [contenteditable="true"]') !== null;
}

function getSelectedStoryId() {
  const stories = getListStoryElements();
  if (!stories.length) {
    return null;
  }

  clampSelectedStoryIndex(stories);
  const selectedStory = stories[selectedStoryIndex];
  if (!selectedStory) {
    return null;
  }

  const fromRow = Number(selectedStory.getAttribute("data-story-id"));
  if (Number.isInteger(fromRow) && fromRow > 0) {
    return fromRow;
  }

  const link = selectedStory.querySelector("[data-story-id]");
  const fromLink = Number(link?.getAttribute("data-story-id"));
  if (Number.isInteger(fromLink) && fromLink > 0) {
    return fromLink;
  }

  return null;
}

function openSelectedStory() {
  const link = getSelectedStoryLink();
  if (!link) {
    return;
  }

  const href = getSafeUrl(link.getAttribute("href"));
  if (href) {
    window.open(href, "_blank", "noopener,noreferrer");
    return;
  }

  const path = getStoryNavigationPath(link);
  if (path) {
    navigateTo(path);
    return;
  }

  link.click();
}

function openSelectedDiscussion() {
  const storyId = getSelectedStoryId();
  if (!storyId) {
    return;
  }
  navigateTo(`/item/${storyId}`);
}

function handleListKeyboardNavigation(event) {
  if (event.defaultPrevented) {
    return;
  }

  if (event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }

  if (isEditableTarget(event.target)) {
    return;
  }

  const stories = getListStoryElements();
  if (!stories.length) {
    return;
  }

  if (event.key === "j" || event.key === "ArrowDown") {
    event.preventDefault();
    selectStoryIndex(selectedStoryIndex + 1);
    return;
  }

  if (event.key === "k" || event.key === "ArrowUp") {
    event.preventDefault();
    selectStoryIndex(selectedStoryIndex - 1);
    return;
  }

  if (event.key === "g" && !event.shiftKey) {
    event.preventDefault();
    selectStoryIndex(0);
    return;
  }

  if (event.key === "G") {
    event.preventDefault();
    selectStoryIndex(stories.length - 1);
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    openSelectedStory();
    return;
  }

  if (event.key === "c" || event.key === "C") {
    event.preventDefault();
    openSelectedDiscussion();
  }
}

function initializeListSelection(listEl) {
  const stories = Array.from(listEl.querySelectorAll(".story"));
  selectedStoryIndex = stories.length ? 0 : -1;
  applyListSelection({ scroll: false });

  if (!listEl.dataset.selectionWired) {
    listEl.dataset.selectionWired = "true";

    listEl.addEventListener("mousemove", (event) => {
      const hovered = event.target.closest(".story");
      if (!hovered || !listEl.contains(hovered)) {
        return;
      }
      const nextIndex = getListStoryElements().indexOf(hovered);
      if (nextIndex >= 0 && nextIndex !== selectedStoryIndex) {
        selectedStoryIndex = nextIndex;
        applyListSelection({ scroll: false });
      }
    });

    listEl.addEventListener("focusin", (event) => {
      const focused = event.target.closest(".story");
      if (!focused || !listEl.contains(focused)) {
        return;
      }
      const nextIndex = getListStoryElements().indexOf(focused);
      if (nextIndex >= 0 && nextIndex !== selectedStoryIndex) {
        selectedStoryIndex = nextIndex;
        applyListSelection({ scroll: false });
      }
    });
  }

  if (!listKeyboardHandler) {
    listKeyboardHandler = handleListKeyboardNavigation;
    document.addEventListener("keydown", listKeyboardHandler);
  }
}

function teardownListSelection() {
  selectedStoryIndex = -1;

  if (listKeyboardHandler) {
    document.removeEventListener("keydown", listKeyboardHandler);
    listKeyboardHandler = null;
  }
}

async function fetchJSON(
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

async function fetchThread(
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

  if (safeOffset === 0 && threadPrefetchCache.has(cacheKey)) {
    try {
      const payload = await threadPrefetchCache.get(cacheKey);
      if (signal?.aborted) {
        throw createAbortError();
      }
      return payload;
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        throw error;
      }
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

function prefetchThread(id, { limit = COMMENTS_PAGE_SIZE } = {}) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return null;
  }

  const cacheKey = `${numericId}:0:${limit}`;
  if (threadPrefetchCache.has(cacheKey)) {
    return threadPrefetchCache.get(cacheKey);
  }

  const promise = fetchJSON(
    `${THREAD_ENDPOINT}?id=${numericId}&offset=0&limit=${limit}`,
    {
      cache: "default",
      errorPrefix: "Thread prefetch failed",
    },
  ).catch((error) => {
    threadPrefetchCache.delete(cacheKey);
    throw error;
  });

  threadPrefetchCache.set(cacheKey, promise);
  while (threadPrefetchCache.size > THREAD_PREFETCH_MAX) {
    const oldest = threadPrefetchCache.keys().next().value;
    threadPrefetchCache.delete(oldest);
  }
  return promise;
}

function wireDiscussionPrefetch(root = app) {
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

function createTaskQueue(limit, { signal } = {}) {
  const queue = [];
  let activeCount = 0;

  const drainOnAbort = () => {
    while (queue.length) {
      const next = queue.shift();
      next.reject(createAbortError());
    }
  };

  const pump = () => {
    if (signal?.aborted) {
      drainOnAbort();
      return;
    }

    while (activeCount < limit && queue.length) {
      const next = queue.shift();
      activeCount += 1;

      Promise.resolve()
        .then(next.task)
        .then(next.resolve, next.reject)
        .finally(() => {
          activeCount -= 1;
          pump();
        });
    }
  };

  if (signal) {
    signal.addEventListener("abort", drainOnAbort, { once: true });
  }

  return (task) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError());
        return;
      }
      queue.push({ task, resolve, reject });
      pump();
    });
}

async function getStories(
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
      const stories = await early.promise;
      if (Array.isArray(stories)) {
        return stories;
      }
    } catch {
      // fall through to a live fetch
    }
  }

  // Same-origin only — no client-side Firebase/Algolia fallback (privacy).
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
  return Array.isArray(payload) ? payload : [];
}

async function getItem(id, { signal } = {}) {
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

function getDomain(url) {
  if (!url) {
    return "";
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function getSafeUrl(url) {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

function timeAgo(unixSeconds) {
  const deltaSeconds = Math.max(
    0,
    Math.floor(Date.now() / 1000) - (unixSeconds || 0),
  );
  if (deltaSeconds < 60) return `${deltaSeconds}s`;
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

function topbar(content) {
  const rightContent = content ?? "";
  return `
    <header class="topbar">
      <div class="topbar-actions">
        ${rightContent}
        <div class="feed-picker" role="group" aria-label="Story feed" data-feed-picker>
          ${FEEDS.map((feed) => getFeedPickerButton(feed)).join("")}
        </div>
        <button
          class="theme-toggle"
          type="button"
          role="switch"
          aria-checked="false"
          aria-label="Use dark mode"
          data-theme-toggle
        ></button>
      </div>
    </header>
  `;
}

function createElementFromHTML(html) {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function createLoadingRow(index, message = "loading...") {
  const row = document.createElement("article");
  row.className = "story";
  row.dataset.storyRank = String(index);
  row.innerHTML = `
    <div class="story-title"><span class="story-title-text">${message}</span></div>
    <div class="story-meta"><span>fetching story details...</span></div>
  `;
  return row;
}

function renderFailedStoryRow(id, index) {
  return `
    <article class="story" data-story-rank="${index}">
      <div class="story-title"><span class="story-title-text">failed to load</span></div>
      <div class="story-meta">
        <span>item ${id}</span>
        <span><button class="btn" type="button" data-retry-id="${id}" data-retry-rank="${index}">retry</button></span>
      </div>
    </article>
  `;
}

async function renderListPage() {
  const controller = new AbortController();
  currentViewController = controller;
  let infiniteObserver = null;
  let scrollFallbackHandler = null;
  const teardownInfiniteLoading = () => {
    if (infiniteObserver) {
      infiniteObserver.disconnect();
      infiniteObserver = null;
    }
    if (scrollFallbackHandler) {
      window.removeEventListener("scroll", scrollFallbackHandler);
      scrollFallbackHandler = null;
    }
  };

  controller.signal.addEventListener("abort", teardownInfiniteLoading, { once: true });

  try {
    app.dataset.view = "list";
    app.innerHTML = `
      <section class="list-pane">
        ${topbar("")}
        <section class="story-list"></section>
        <p class="status" data-list-status hidden></p>
        <div data-list-sentinel aria-hidden="true"></div>
      </section>
    `;
    wireThemeToggle();
    wireFeedToggleButtons();
    wireDiscussionPrefetch(app);

    const listEl = app.querySelector(".story-list");
    const listStatus = app.querySelector("[data-list-status]");
    const sentinel = app.querySelector("[data-list-sentinel]");
    if (!listEl || !listStatus || !sentinel) {
      return;
    }

    initializeListSelection(listEl);

    const setListStatus = (value = "") => {
      const next = (value || "").trim();
      listStatus.hidden = !next;
      listStatus.textContent = next;
    };

    const replaceRow = (sourceRow, html) => {
      if (!sourceRow || !sourceRow.isConnected) {
        return;
      }
      const next = createElementFromHTML(html);
      if (!next) {
        return;
      }
      sourceRow.replaceWith(next);
      applyListSelection({ scroll: false });
    };

    listEl.addEventListener("click", async (event) => {
      const titleLink = event.target.closest(".story-title a");
      if (titleLink && listEl.contains(titleLink)) {
        const storyRow = titleLink.closest(".story");
        if (storyRow) {
          setSelectedStoryElement(storyRow);
        }
        return;
      }

      const discussionLink = event.target.closest("a.meta-time");
      if (discussionLink && listEl.contains(discussionLink)) {
        const storyRow = discussionLink.closest(".story");
        if (storyRow) {
          setSelectedStoryElement(storyRow);
        }
        return;
      }

      const retryButton = event.target.closest("[data-retry-id]");
      if (!retryButton) {
        return;
      }
      event.preventDefault();

      if (controller.signal.aborted || currentViewController !== controller) {
        return;
      }

      const id = Number(retryButton.getAttribute("data-retry-id"));
      const rank = Number(retryButton.getAttribute("data-retry-rank"));
      const row = retryButton.closest(".story");
      if (!Number.isFinite(id) || !Number.isInteger(rank) || !row || !row.isConnected) {
        return;
      }

      const loadingRow = createLoadingRow(rank, "retrying...");
      row.replaceWith(loadingRow);
      applyListSelection({ scroll: false });

      let story = null;
      try {
        story = await getItem(id, {
          signal: controller.signal,
        });
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
      }

      if (controller.signal.aborted || currentViewController !== controller) {
        return;
      }

      if (story) {
        replaceRow(loadingRow, renderStoryRow(story, rank));
        return;
      }

      replaceRow(loadingRow, renderFailedStoryRow(id, rank));
    });

    let isLoadingBatch = false;
    let hasMore = true;
    let nextBatchStart = 0;
    const seenStoryIds = new Set();

    const handleBackgroundLoadError = (error) => {
      if (
        isAbortError(error) ||
        controller.signal.aborted ||
        currentViewController !== controller
      ) {
        return;
      }
      hasMore = false;
      teardownInfiniteLoading();
      setListStatus(`Could not load stories: ${error.message}`);
    };

    const loadNextBatchInBackground = () => {
      void loadNextBatch().catch(handleBackgroundLoadError);
    };

    const shouldLoadMoreNow = () => {
      if (!sentinel.isConnected) {
        return false;
      }
      const rect = sentinel.getBoundingClientRect();
      return rect.top <= window.innerHeight + 600;
    };

    const requestNextBatchIfNeeded = () => {
      if (
        hasMore &&
        !isLoadingBatch &&
        !controller.signal.aborted &&
        currentViewController === controller &&
        shouldLoadMoreNow()
      ) {
        window.setTimeout(() => {
          loadNextBatchInBackground();
        }, 0);
      }
    };

    const loadNextBatch = async () => {
      if (
        isLoadingBatch ||
        controller.signal.aborted ||
        currentViewController !== controller ||
        !hasMore
      ) {
        return;
      }

      isLoadingBatch = true;
      setListStatus("Loading stories...");

      try {
        const batchStart = nextBatchStart;
        const batchLimit = batchStart === 0 ? INITIAL_PAGE_SIZE : PAGE_SIZE;
        const fetchedStories = await getStories(currentFeed, {
          signal: controller.signal,
          offset: batchStart,
          limit: batchLimit,
        });
        if (controller.signal.aborted || currentViewController !== controller) {
          return;
        }

        if (!fetchedStories.length) {
          hasMore = false;
          teardownInfiniteLoading();
          setListStatus(batchStart === 0 ? "No stories available." : "");
          return;
        }

        const batchStories = fetchedStories.filter((story) => {
          const storyId = Number(story?.id);
          if (!Number.isFinite(storyId)) {
            return true;
          }
          if (seenStoryIds.has(storyId)) {
            return false;
          }
          seenStoryIds.add(storyId);
          return true;
        });

        if (!batchStories.length) {
          hasMore = false;
          teardownInfiniteLoading();
          setListStatus("");
          return;
        }

        nextBatchStart += fetchedStories.length;

        const fragment = document.createDocumentFragment();
        const nextRows = [];
        batchStories.forEach((story, index) => {
          const rank = batchStart + index + 1;
          const html =
            story && Number.isFinite(Number(story.id))
              ? renderStoryRow(story, rank)
              : renderFailedStoryRow("unknown", rank);
          const row = createElementFromHTML(html);
          if (row) {
            nextRows.push(row);
            fragment.appendChild(row);
          }
        });

        listEl.appendChild(fragment);

        if (selectedStoryIndex < 0 && nextRows.length) {
          selectedStoryIndex = 0;
        }
        applyListSelection({ scroll: false });

        if (controller.signal.aborted || currentViewController !== controller) {
          return;
        }

        if (fetchedStories.length < batchLimit) {
          hasMore = false;
          teardownInfiniteLoading();
        }

        setListStatus("");
      } finally {
        isLoadingBatch = false;
        requestNextBatchIfNeeded();
      }
    };

    if ("IntersectionObserver" in window) {
      infiniteObserver = new IntersectionObserver(
        (entries) => {
          const shouldLoad = entries.some((entry) => entry.isIntersecting);
          if (shouldLoad) {
            loadNextBatchInBackground();
          }
        },
        { rootMargin: "600px 0px" },
      );
      infiniteObserver.observe(sentinel);
    } else {
      scrollFallbackHandler = () => {
        if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 600) {
          loadNextBatchInBackground();
        }
      };
      window.addEventListener("scroll", scrollFallbackHandler, { passive: true });
    }

    await loadNextBatch();
  } catch (error) {
    teardownInfiniteLoading();
    if (
      isAbortError(error) ||
      controller.signal.aborted ||
      currentViewController !== controller
    ) {
      return;
    }
    app.innerHTML = `
      <section class="list-pane">
        ${topbar("")}
        <p class="status">Could not load stories: ${escapeHTML(error.message)}</p>
      </section>
    `;
    wireThemeToggle();
    wireFeedToggleButtons();
  }
}

function renderStoryRow(story, index) {
  if (!story) {
    return "";
  }

  const storyId = Number(story.id);
  const domain = story.domain || getDomain(story.url);
  const safeUrl = getSafeUrl(story.url);
  const discussionPath = Number.isInteger(storyId) && storyId > 0 ? `#/item/${storyId}` : "#/";
  const storyUrl = safeUrl || discussionPath;
  const storyTitleRaw = story.title || "Untitled";
  const storyTitle = escapeHTML(storyTitleRaw);
  const escapedStoryDomain = escapeHTML(domain);
  const escapedStoryUrl = escapeHTML(storyUrl);
  const isExternal = Boolean(safeUrl);
  const titleContent = `
    <a
      href="${escapedStoryUrl}"
      ${isExternal ? 'target="_blank" rel="noopener noreferrer"' : ""}
      data-story-id="${storyId}"
    ><span class="story-title-text">${storyTitle}</span></a>
  `;

  return `
    <article class="story" data-story-rank="${index}" data-story-id="${storyId}">
      <div class="story-title">
        ${titleContent}
        ${domain ? `<span class="domain">(${escapedStoryDomain})</span>` : ""}
      </div>
      <div class="story-meta">
        <a class="meta-time" href="${escapeHTML(discussionPath)}">${timeAgo(story.time)} ago</a>
      </div>
    </article>
  `;
}

function sanitizeHNHTML(value) {
  const clean = DOMPurify.sanitize(value ?? "", {
    ALLOWED_TAGS: SANITIZE_ALLOWED_TAGS,
    ALLOWED_ATTR: ["href"],
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    // http(s) only — blocks javascript:, data:, vbscript:, etc.
    ALLOWED_URI_REGEXP: /^(?:https?:)/i,
    RETURN_DOM_FRAGMENT: true,
  });

  clean.querySelectorAll("a").forEach((anchor) => {
    const safeHref = getSafeUrl(anchor.getAttribute("href"));
    if (safeHref) {
      anchor.setAttribute("href", safeHref);
      anchor.setAttribute("rel", "noopener noreferrer");
      anchor.setAttribute("target", "_blank");
    } else {
      anchor.removeAttribute("href");
      anchor.removeAttribute("target");
      anchor.removeAttribute("rel");
    }
  });

  const serializer = document.createElement("div");
  serializer.appendChild(clean);
  return serializer.innerHTML;
}

function normalizeStoryDetail(story) {
  if (!story || typeof story !== "object") {
    return null;
  }

  const id = Number(story.id);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }

  const time = Number(story.time ?? story.created_at_i);
  const url = typeof story.url === "string" ? story.url : "";
  const by =
    (typeof story.by === "string" && story.by) ||
    (typeof story.author === "string" && story.author) ||
    "";

  return {
    id,
    title: typeof story.title === "string" ? story.title : "",
    url,
    by,
    time: Number.isFinite(time) ? time : 0,
    text: typeof story.text === "string" ? story.text : "",
    score: Number.isFinite(Number(story.score ?? story.points))
      ? Number(story.score ?? story.points)
      : 0,
  };
}

function renderStoryDetail(story) {
  const normalized = normalizeStoryDetail(story) || story;
  const domain = getDomain(normalized.url);
  const safeUrl = getSafeUrl(normalized.url);
  const title = escapeHTML(normalized.title || "Untitled");
  const storyText = normalized.text ? sanitizeHNHTML(normalized.text) : "";
  const byline = normalized.by ? escapeHTML(normalized.by) : "";

  return `
    <article class="story story-detail">
      <div class="story-title">
        ${safeUrl ? `<a href="${escapeHTML(safeUrl)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title}
        ${domain ? `<span class="domain">(${escapeHTML(domain)})</span>` : ""}
      </div>
      <div class="story-meta">
        ${byline ? `<span class="meta-user">${byline}</span>` : ""}
        <span class="meta-time">${timeAgo(normalized.time)} ago</span>
      </div>
      ${storyText ? `<div class="story-text">${storyText}</div>` : ""}
    </article>
  `;
}

function applyCommentDepth(element, depth) {
  const safeDepth = Math.max(0, Number(depth) || 0);
  const visualDepth = Math.min(safeDepth, MAX_COMMENT_DEPTH);
  element.dataset.depth = String(safeDepth);
  element.style.setProperty("--comment-depth", String(visualDepth));
}

function normalizeThreadComment(node) {
  if (!node || typeof node !== "object") {
    return null;
  }

  const id = Number(node.id);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }

  const time = Number(node.time ?? node.created_at_i);
  const replyCount = Number(node.replyCount ?? node.reply_count ?? 0);

  return {
    id,
    by:
      (typeof node.by === "string" && node.by) ||
      (typeof node.author === "string" && node.author) ||
      "unknown",
    time: Number.isFinite(time) ? time : 0,
    text: typeof node.text === "string" ? node.text : "",
    replyCount: Number.isFinite(replyCount) && replyCount > 0 ? replyCount : 0,
    deleted: Boolean(node.deleted),
    dead: Boolean(node.dead),
  };
}

function createCommentRenderState({ signal, sectionEl, rootEl, statusEl, parentId }) {
  return {
    signal,
    sectionEl,
    rootEl,
    statusEl,
    parentId: Number(parentId) || 0,
    enqueueRender: createTaskQueue(1, { signal }),
    childLists: new Map(),
    replyModels: new Map(),
    nextListId: 1,
    loadedCount: 0,
    rootNextOffset: 0,
    rootTotal: 0,
    rootHasMore: false,
  };
}

function updateCommentStatus(state) {
  if (!state.statusEl || !state.statusEl.isConnected) {
    return;
  }

  if (state.loadedCount === 0 && !state.rootHasMore) {
    state.statusEl.textContent = "No comments yet.";
    return;
  }

  if (state.loadedCount === 0) {
    state.statusEl.textContent = "Loading comments…";
    return;
  }

  const totalHint =
    state.rootTotal > state.loadedCount ? ` · ${state.rootTotal} top-level` : "";
  state.statusEl.textContent = `${state.loadedCount} shown${totalHint}`;
}

function removeLoadMoreControl(model) {
  if (model.controlEl && model.controlEl.isConnected) {
    model.controlEl.remove();
  }
  model.controlEl = null;
}

function renderLoadMoreControl(
  model,
  remaining,
  { action = "load-more-children", extra = {} } = {},
) {
  removeLoadMoreControl(model);

  if (remaining <= 0 || !model.container?.isConnected) {
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "comment-load-more";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn comment-load-more-btn";
  button.dataset.action = action;
  if (model.id) {
    button.dataset.listId = model.id;
  }
  Object.entries(extra).forEach(([key, value]) => {
    button.dataset[key] = String(value);
  });
  button.textContent = `Load more (${remaining})`;

  wrap.appendChild(button);
  model.container.appendChild(wrap);
  model.controlEl = wrap;
}

function maybeClampCommentText(textEl) {
  if (!textEl?.isConnected || textEl.dataset.clampChecked === "true") {
    return;
  }
  textEl.dataset.clampChecked = "true";

  if (textEl.scrollHeight <= COMMENT_CLAMP_PX + 8) {
    return;
  }

  textEl.classList.add("is-clamped");
  textEl.style.maxHeight = `${COMMENT_CLAMP_PX}px`;

  const more = document.createElement("button");
  more.type = "button";
  more.className = "comment-show-more";
  more.dataset.action = "expand-text";
  more.textContent = "Show more";
  textEl.insertAdjacentElement("afterend", more);
}

function createCommentElement(state, item, depth) {
  const article = document.createElement("article");
  article.className = "comment";
  article.dataset.commentId = String(item.id);
  article.tabIndex = -1;
  applyCommentDepth(article, depth);

  const header = document.createElement("div");
  header.className = "comment-header";

  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "comment-toggle";
  toggleButton.dataset.action = "toggle-comment";
  toggleButton.setAttribute("aria-label", "Collapse comment");
  toggleButton.title = "Collapse";
  toggleButton.innerHTML =
    '<svg class="comment-chevron" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const meta = document.createElement("div");
  meta.className = "comment-meta";

  if (item.deleted || item.dead) {
    const statusSpan = document.createElement("span");
    statusSpan.className = "comment-status";
    statusSpan.textContent = item.deleted ? "[deleted]" : "[dead]";
    meta.append(statusSpan);
  } else {
    const bySpan = document.createElement("span");
    bySpan.className = "meta-user";
    bySpan.textContent = item.by && item.by !== "unknown" ? item.by : "unknown";

    const timeSpan = document.createElement("span");
    timeSpan.className = "meta-time";
    timeSpan.textContent = item.time ? `${timeAgo(item.time)} ago` : "";

    meta.append(bySpan);
    if (timeSpan.textContent) {
      meta.append(timeSpan);
    }
  }

  header.append(toggleButton, meta);

  if (item.replyCount > 0) {
    const repliesButton = document.createElement("button");
    repliesButton.type = "button";
    repliesButton.className = "comment-replies-btn";
    repliesButton.dataset.action = "load-replies";
    repliesButton.dataset.commentId = String(item.id);
    repliesButton.textContent =
      item.replyCount === 1 ? "1 reply" : `${item.replyCount} replies`;
    repliesButton.setAttribute(
      "aria-label",
      `Show ${item.replyCount} ${item.replyCount === 1 ? "reply" : "replies"}`,
    );
    header.appendChild(repliesButton);

    state.replyModels.set(item.id, {
      id: item.id,
      replyCount: item.replyCount,
      depth: depth + 1,
      container: null,
      loaded: false,
      loading: false,
      nextOffset: 0,
      hasMore: false,
      total: item.replyCount,
      buttonEl: repliesButton,
    });
  }

  const text = document.createElement("div");
  text.className = "comment-text";

  if (item.deleted) {
    text.textContent = "[deleted]";
  } else if (item.dead) {
    text.textContent = "[dead]";
  } else if (item.text) {
    text.innerHTML = sanitizeHNHTML(item.text);
  } else {
    text.textContent = "[no text]";
  }

  const children = document.createElement("div");
  children.className = "comment-children";

  const replyModel = state.replyModels.get(item.id);
  if (replyModel) {
    replyModel.container = children;
  }

  article.append(header, text, children);
  return article;
}

function queueCommentBatchRender(state, model, items) {
  return state
    .enqueueRender(
      () =>
        new Promise((resolve, reject) => {
          if (state.signal.aborted || !model.container?.isConnected) {
            resolve();
            return;
          }

          window.requestAnimationFrame(() => {
            if (state.signal.aborted || !model.container?.isConnected) {
              resolve();
              return;
            }

            try {
              const fragment = document.createDocumentFragment();
              const created = [];

              items.forEach((item) => {
                const el = createCommentElement(state, item, model.depth);
                fragment.appendChild(el);
                created.push(el);
              });

              model.container.appendChild(fragment);
              state.loadedCount += items.length;
              updateCommentStatus(state);

              created.forEach((el) => {
                maybeClampCommentText(el.querySelector(".comment-text"));
              });

              resolve();
            } catch (error) {
              reject(error);
            }
          });
        }),
    )
    .catch((error) => {
      if (!isAbortError(error) && !state.signal.aborted) {
        console.error("Failed to render comments batch.", error);
      }
    });
}

function loadChildBatch(state, model, { manual = false } = {}) {
  if (state.signal.aborted || !model?.container?.isConnected) {
    return;
  }

  removeLoadMoreControl(model);

  const remaining = model.items.length - model.nextIndex;
  if (remaining <= 0) {
    if (model.serverHasMore) {
      renderLoadMoreControl(model, model.serverTotal - model.serverNextOffset, {
        action: "load-more-server",
        extra: { parentId: model.serverParentId },
      });
    }
    return;
  }

  const count = Math.min(COMMENTS_DOM_BATCH, remaining);
  const batch = model.items.slice(model.nextIndex, model.nextIndex + count);
  model.nextIndex += count;

  void queueCommentBatchRender(state, model, batch).then(() => {
    if (state.signal.aborted || !model.container?.isConnected) {
      return;
    }
    const remainingAfter = model.items.length - model.nextIndex;
    if (remainingAfter > 0) {
      // Auto-stream the first couple of DOM batches, then ask.
      if (
        model.auto &&
        !manual &&
        model.nextIndex <= COMMENTS_DOM_BATCH * 2
      ) {
        loadChildBatch(state, model, { manual: false });
        return;
      }
      renderLoadMoreControl(model, remainingAfter);
      return;
    }
    if (model.serverHasMore) {
      renderLoadMoreControl(
        model,
        Math.max(0, model.serverTotal - model.serverNextOffset),
        {
          action: "load-more-server",
          extra: { parentId: model.serverParentId },
        },
      );
    }
  });
}

function mountChildList(
  state,
  container,
  comments,
  depth,
  {
    auto = true,
    serverParentId = 0,
    serverNextOffset = 0,
    serverTotal = 0,
    serverHasMore = false,
  } = {},
) {
  const normalizedComments = Array.isArray(comments)
    ? comments.map((comment) => normalizeThreadComment(comment)).filter(Boolean)
    : [];
  if (!container?.isConnected) {
    return;
  }
  if (!normalizedComments.length && !serverHasMore) {
    return;
  }

  const listId = `list-${state.nextListId}`;
  state.nextListId += 1;

  const model = {
    id: listId,
    container,
    items: normalizedComments,
    nextIndex: 0,
    depth,
    auto,
    controlEl: null,
    serverParentId,
    serverNextOffset,
    serverTotal,
    serverHasMore,
  };

  state.childLists.set(listId, model);
  container.dataset.listId = listId;

  if (normalizedComments.length) {
    loadChildBatch(state, model, { manual: !auto });
  } else if (serverHasMore) {
    renderLoadMoreControl(model, serverTotal, {
      action: "load-more-server",
      extra: { parentId: serverParentId },
    });
  }
}

async function fetchAndMountReplies(state, model) {
  if (!model || model.loading || state.signal.aborted) {
    return;
  }

  model.loading = true;
  if (model.buttonEl) {
    model.buttonEl.disabled = true;
    model.buttonEl.textContent = "Loading…";
  }

  try {
    const offset = model.loaded ? model.nextOffset : 0;
    const data = await fetchThread(model.id, {
      signal: state.signal,
      offset,
      limit: COMMENTS_PAGE_SIZE,
    });

    if (state.signal.aborted || !model.container?.isConnected) {
      return;
    }

    const comments = Array.isArray(data?.comments) ? data.comments : [];
    const nextOffset = (Number(data?.offset) || 0) + comments.length;
    const total = Number(data?.total) || model.replyCount;
    const hasMore = Boolean(data?.hasMore);

    if (!model.loaded) {
      model.loaded = true;
      model.container.replaceChildren();
      mountChildList(state, model.container, comments, model.depth, {
        auto: true,
        serverParentId: model.id,
        serverNextOffset: nextOffset,
        serverTotal: total,
        serverHasMore: hasMore,
      });
    } else {
      const listId = model.container.dataset.listId;
      const listModel = listId ? state.childLists.get(listId) : null;
      if (listModel) {
        listModel.items.push(
          ...comments.map((c) => normalizeThreadComment(c)).filter(Boolean),
        );
        listModel.serverNextOffset = nextOffset;
        listModel.serverHasMore = hasMore;
        listModel.serverTotal = total;
        loadChildBatch(state, listModel, { manual: true });
      } else {
        mountChildList(state, model.container, comments, model.depth, {
          auto: false,
          serverParentId: model.id,
          serverNextOffset: nextOffset,
          serverTotal: total,
          serverHasMore: hasMore,
        });
      }
    }

    model.nextOffset = nextOffset;
    model.hasMore = hasMore;
    model.total = total;

    if (model.buttonEl) {
      model.buttonEl.disabled = false;
      model.buttonEl.classList.add("is-open");
      model.buttonEl.textContent =
        model.replyCount === 1 ? "1 reply" : `${model.replyCount} replies`;
      model.buttonEl.setAttribute("aria-label", "Replies expanded");
    }
  } catch (error) {
    if (isAbortError(error) || state.signal.aborted) {
      return;
    }
    if (model.buttonEl) {
      model.buttonEl.disabled = false;
      model.buttonEl.textContent = "Retry replies";
    }
    console.error("Failed to load replies.", error);
  } finally {
    model.loading = false;
  }
}

async function loadMoreServerPage(state, listModel) {
  if (!listModel?.serverParentId || state.signal.aborted) {
    return;
  }

  removeLoadMoreControl(listModel);
  const statusBtn = document.createElement("div");
  statusBtn.className = "comment-load-more";
  statusBtn.innerHTML = '<span class="status">Loading…</span>';
  listModel.container.appendChild(statusBtn);
  listModel.controlEl = statusBtn;

  try {
    const data = await fetchThread(listModel.serverParentId, {
      signal: state.signal,
      offset: listModel.serverNextOffset,
      limit: COMMENTS_PAGE_SIZE,
    });

    if (state.signal.aborted || !listModel.container?.isConnected) {
      return;
    }

    removeLoadMoreControl(listModel);

    const comments = (Array.isArray(data?.comments) ? data.comments : [])
      .map((c) => normalizeThreadComment(c))
      .filter(Boolean);
    listModel.items.push(...comments);
    listModel.serverNextOffset =
      (Number(data?.offset) || listModel.serverNextOffset) + comments.length;
    listModel.serverHasMore = Boolean(data?.hasMore);
    listModel.serverTotal = Number(data?.total) || listModel.serverTotal;

    loadChildBatch(state, listModel, { manual: true });
  } catch (error) {
    if (isAbortError(error) || state.signal.aborted) {
      return;
    }
    removeLoadMoreControl(listModel);
    renderLoadMoreControl(
      listModel,
      Math.max(0, listModel.serverTotal - listModel.serverNextOffset),
      {
        action: "load-more-server",
        extra: { parentId: listModel.serverParentId },
      },
    );
    console.error("Failed to load more comments.", error);
  }
}

function getVisibleCommentElements() {
  return Array.from(app.querySelectorAll(".comments .comment")).filter((el) => {
    if (!el.offsetParent && el.offsetHeight === 0) {
      return false;
    }
    // Skip comments inside a collapsed ancestor.
    return !el.parentElement?.closest?.(".comment.is-collapsed");
  });
}

function applyCommentSelection({ scroll = false } = {}) {
  const comments = Array.from(app.querySelectorAll(".comments .comment"));
  comments.forEach((el) => el.classList.remove("is-selected"));

  const visible = getVisibleCommentElements();
  if (!visible.length) {
    selectedCommentIndex = -1;
    return;
  }

  if (selectedCommentIndex < 0) {
    selectedCommentIndex = 0;
  }
  if (selectedCommentIndex >= visible.length) {
    selectedCommentIndex = visible.length - 1;
  }

  visible[selectedCommentIndex].classList.add("is-selected");

  if (scroll) {
    visible[selectedCommentIndex].scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }
}

function selectCommentIndex(nextIndex, { scroll = true } = {}) {
  const visible = getVisibleCommentElements();
  if (!visible.length) {
    selectedCommentIndex = -1;
    return;
  }
  selectedCommentIndex = Math.max(0, Math.min(nextIndex, visible.length - 1));
  applyCommentSelection({ scroll });
}

function activateSelectedCommentReplies() {
  const visible = getVisibleCommentElements();
  const selected = visible[selectedCommentIndex];
  if (!selected) {
    return;
  }
  const replies = selected.querySelector(
    ':scope > .comment-header [data-action="load-replies"]',
  );
  if (replies && !replies.disabled) {
    replies.click();
  }
}

function toggleSelectedComment() {
  const visible = getVisibleCommentElements();
  const selected = visible[selectedCommentIndex];
  if (!selected) {
    return;
  }
  const toggle = selected.querySelector(
    ':scope > .comment-header [data-action="toggle-comment"]',
  );
  if (toggle) {
    toggle.click();
  }
}

function handleStoryKeyboardNavigation(event) {
  if (event.defaultPrevented || app.dataset.view !== "story") {
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }
  if (isEditableTarget(event.target)) {
    return;
  }

  if (event.key === "j" || event.key === "ArrowDown") {
    event.preventDefault();
    selectCommentIndex(selectedCommentIndex + 1);
    return;
  }
  if (event.key === "k" || event.key === "ArrowUp") {
    event.preventDefault();
    selectCommentIndex(selectedCommentIndex - 1);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    activateSelectedCommentReplies();
    return;
  }
  if (event.key === "h" || event.key === "H") {
    event.preventDefault();
    toggleSelectedComment();
    return;
  }
  if (event.key === "g" && !event.shiftKey) {
    event.preventDefault();
    selectCommentIndex(0);
    return;
  }
  if (event.key === "G") {
    event.preventDefault();
    selectCommentIndex(getVisibleCommentElements().length - 1);
  }
}

function teardownStoryKeyboard() {
  selectedCommentIndex = -1;
  if (storyKeyboardHandler) {
    document.removeEventListener("keydown", storyKeyboardHandler);
    storyKeyboardHandler = null;
  }
}

function initializeStoryKeyboard() {
  teardownStoryKeyboard();
  storyKeyboardHandler = handleStoryKeyboardNavigation;
  document.addEventListener("keydown", storyKeyboardHandler);
}

function wireCommentActions(state) {
  const previousHandler = commentActionHandlers.get(state.sectionEl);
  if (previousHandler) {
    state.sectionEl.removeEventListener("click", previousHandler);
  }

  const clickHandler = (event) => {
    const actionEl = event.target.closest("[data-action]");
    if (!actionEl || !state.sectionEl.contains(actionEl)) {
      const comment = event.target.closest(".comment");
      if (comment && state.sectionEl.contains(comment)) {
        const visible = getVisibleCommentElements();
        const idx = visible.indexOf(comment);
        if (idx >= 0) {
          selectedCommentIndex = idx;
          applyCommentSelection({ scroll: false });
        }
      }
      return;
    }

    const action = actionEl.getAttribute("data-action");
    if (!action) {
      return;
    }

    if (action === "expand-text") {
      const textEl = actionEl.previousElementSibling;
      if (textEl?.classList.contains("comment-text")) {
        textEl.classList.remove("is-clamped");
        textEl.style.maxHeight = "";
      }
      actionEl.remove();
      return;
    }

    if (action === "load-more-children") {
      const listId = actionEl.getAttribute("data-list-id") || "";
      const model = state.childLists.get(listId);
      if (!model) {
        return;
      }
      loadChildBatch(state, model, { manual: true });
      return;
    }

    if (action === "load-more-server") {
      const listId = actionEl.getAttribute("data-list-id") || "";
      const model = state.childLists.get(listId);
      if (model) {
        void loadMoreServerPage(state, model);
        return;
      }
      const parentId = Number(
        actionEl.getAttribute("data-parent-id") ||
          actionEl.dataset.parentId ||
          0,
      );
      if (Number.isInteger(parentId) && parentId > 0) {
        void loadMoreRootComments(state, parentId);
      }
      return;
    }

    if (action === "load-replies") {
      const commentId = Number(actionEl.getAttribute("data-comment-id"));
      if (!Number.isFinite(commentId)) {
        return;
      }
      const model = state.replyModels.get(commentId);
      if (!model) {
        return;
      }
      if (model.loaded && !model.hasMore) {
        const comment = actionEl.closest(".comment");
        comment?.classList.toggle("is-collapsed");
        return;
      }
      void fetchAndMountReplies(state, model);
      return;
    }

    if (action === "toggle-comment") {
      const comment = actionEl.closest(".comment");
      if (!comment) {
        return;
      }
      const isCollapsed = comment.classList.toggle("is-collapsed");
      const nextLabel = isCollapsed ? "Expand comment" : "Collapse comment";
      actionEl.setAttribute("aria-label", nextLabel);
      actionEl.title = isCollapsed ? "Expand" : "Collapse";
    }
  };

  state.sectionEl.addEventListener("click", clickHandler);
  commentActionHandlers.set(state.sectionEl, clickHandler);
}

async function loadMoreRootComments(state, parentId) {
  if (state.signal.aborted || !state.rootHasMore) {
    return;
  }

  const footer = state.sectionEl.querySelector("[data-root-more]");
  if (footer) {
    footer.innerHTML = '<span class="status">Loading…</span>';
  }

  try {
    const data = await fetchThread(parentId, {
      signal: state.signal,
      offset: state.rootNextOffset,
      limit: COMMENTS_PAGE_SIZE,
    });

    if (state.signal.aborted) {
      return;
    }

    const comments = Array.isArray(data?.comments) ? data.comments : [];
    state.rootNextOffset =
      (Number(data?.offset) || state.rootNextOffset) + comments.length;
    state.rootHasMore = Boolean(data?.hasMore);
    state.rootTotal = Number(data?.total) || state.rootTotal;

    const listId = state.rootEl.dataset.listId;
    const listModel = listId ? state.childLists.get(listId) : null;
    if (listModel) {
      listModel.items.push(
        ...comments.map((c) => normalizeThreadComment(c)).filter(Boolean),
      );
      listModel.serverNextOffset = state.rootNextOffset;
      listModel.serverHasMore = state.rootHasMore;
      listModel.serverTotal = state.rootTotal;
      loadChildBatch(state, listModel, { manual: true });
    } else {
      mountChildList(state, state.rootEl, comments, 0, {
        auto: false,
        serverParentId: parentId,
        serverNextOffset: state.rootNextOffset,
        serverTotal: state.rootTotal,
        serverHasMore: state.rootHasMore,
      });
    }

    renderRootMoreFooter(state, parentId);
    updateCommentStatus(state);
  } catch (error) {
    if (isAbortError(error) || state.signal.aborted) {
      return;
    }
    if (footer) {
      footer.innerHTML = "";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn comment-load-more-btn";
      btn.dataset.action = "load-more-server";
      btn.dataset.parentId = String(parentId);
      btn.textContent = "Retry loading comments";
      footer.appendChild(btn);
    }
  }
}

function renderRootMoreFooter(state, parentId) {
  let footer = state.sectionEl.querySelector("[data-root-more]");
  if (!footer) {
    footer = document.createElement("div");
    footer.className = "comment-load-more";
    footer.dataset.rootMore = "true";
    state.sectionEl.appendChild(footer);
  }

  footer.replaceChildren();
  if (!state.rootHasMore) {
    footer.hidden = true;
    return;
  }

  footer.hidden = false;
  const remaining = Math.max(0, state.rootTotal - state.rootNextOffset);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn comment-load-more-btn";
  btn.dataset.action = "load-more-server";
  btn.dataset.parentId = String(parentId);
  btn.textContent = remaining
    ? `Load more comments (${remaining})`
    : "Load more comments";
  footer.appendChild(btn);
}

function paintStoryDetail(detailSlot, story) {
  if (!detailSlot?.isConnected) {
    return null;
  }
  const html = renderStoryDetail(story);
  const rendered = createElementFromHTML(html);
  if (!rendered) {
    return detailSlot;
  }
  detailSlot.replaceWith(rendered);
  return rendered;
}

async function renderStoryPage(id) {
  const storyId = Number(id);
  app.dataset.view = "story";
  teardownStoryKeyboard();

  if (!Number.isFinite(storyId) || storyId <= 0) {
    app.innerHTML = `
      <section class="list-pane">
        ${topbar('<a class="btn" href="#/">back</a>')}
        <p class="status">Invalid story id.</p>
      </section>
    `;
    wireThemeToggle();
    wireFeedToggleButtons();
    return;
  }

  const controller = new AbortController();
  currentViewController = controller;

  app.innerHTML = `
    <section class="list-pane">
      ${topbar('<a class="btn" href="#/">back</a>')}
      <article class="story story-detail" data-story-shell>
        <div class="story-title story-title-skeleton">Loading story…</div>
        <div class="story-meta"><span class="status">Fetching details…</span></div>
      </article>
      <section class="comments" aria-live="polite">
        <h2 class="comments-title">Comments</h2>
        <p class="status" data-comments-status>Loading comments…</p>
        <div class="comment-skeleton" data-comment-skeleton aria-hidden="true">
          <div class="comment-skeleton-line"></div>
          <div class="comment-skeleton-line short"></div>
          <div class="comment-skeleton-line"></div>
        </div>
        <div class="comment-children" data-comments-root></div>
      </section>
    </section>
  `;
  wireThemeToggle();
  wireFeedToggleButtons();
  wireDiscussionPrefetch(app);

  let detailSlot = app.querySelector("[data-story-shell]");
  const commentsSection = app.querySelector(".comments");
  const commentsRoot = app.querySelector("[data-comments-root]");
  const commentsStatus = app.querySelector("[data-comments-status]");
  const skeleton = app.querySelector("[data-comment-skeleton]");

  if (!detailSlot || !commentsSection || !commentsRoot || !commentsStatus) {
    return;
  }

  const itemPromise = getItem(storyId, { signal: controller.signal }).catch(
    () => null,
  );
  const threadPromise = fetchThread(storyId, {
    signal: controller.signal,
    offset: 0,
    limit: COMMENTS_PAGE_SIZE,
  });

  void itemPromise.then((item) => {
    if (
      controller.signal.aborted ||
      currentViewController !== controller ||
      !detailSlot?.isConnected
    ) {
      return;
    }
    if (item && normalizeStoryDetail(item)) {
      detailSlot = paintStoryDetail(detailSlot, item) || detailSlot;
    }
  });

  let thread = null;
  try {
    thread = await threadPromise;
  } catch (error) {
    if (
      isAbortError(error) ||
      controller.signal.aborted ||
      currentViewController !== controller
    ) {
      return;
    }

    if (detailSlot?.isConnected && detailSlot.hasAttribute("data-story-shell")) {
      detailSlot.innerHTML = `
        <div class="story-title">failed to load story</div>
        <div class="story-meta"><span>${escapeHTML(error.message)}</span></div>
      `;
    }
    skeleton?.remove();
    commentsStatus.textContent = "Could not load comments.";
    return;
  }

  if (controller.signal.aborted || currentViewController !== controller) {
    return;
  }

  if (thread && normalizeStoryDetail(thread)) {
    if (detailSlot?.isConnected) {
      detailSlot = paintStoryDetail(detailSlot, thread) || detailSlot;
    }
  } else if (detailSlot?.hasAttribute?.("data-story-shell")) {
    const item = await itemPromise;
    if (controller.signal.aborted || currentViewController !== controller) {
      return;
    }
    if (item && normalizeStoryDetail(item)) {
      detailSlot = paintStoryDetail(detailSlot, item) || detailSlot;
    } else if (detailSlot?.isConnected) {
      detailSlot.innerHTML = `<div class="story-title">story not found</div>`;
      skeleton?.remove();
      commentsStatus.textContent = "No comments available.";
      return;
    }
  }

  skeleton?.remove();

  const commentState = createCommentRenderState({
    signal: controller.signal,
    sectionEl: commentsSection,
    rootEl: commentsRoot,
    statusEl: commentsStatus,
    parentId: storyId,
  });

  const rootComments = Array.isArray(thread?.comments) ? thread.comments : [];
  commentState.rootNextOffset =
    (Number(thread?.offset) || 0) + rootComments.length;
  commentState.rootTotal = Number(thread?.total) || rootComments.length;
  commentState.rootHasMore = Boolean(thread?.hasMore);

  wireCommentActions(commentState);
  initializeStoryKeyboard();

  if (!rootComments.length && !commentState.rootHasMore) {
    commentsStatus.textContent = "No comments yet.";
    return;
  }

  mountChildList(commentState, commentState.rootEl, rootComments, 0, {
    auto: true,
    serverParentId: storyId,
    serverNextOffset: commentState.rootNextOffset,
    serverTotal: commentState.rootTotal,
    serverHasMore: commentState.rootHasMore,
  });
  renderRootMoreFooter(commentState, storyId);
  updateCommentStatus(commentState);

  window.requestAnimationFrame(() => {
    if (!controller.signal.aborted) {
      selectCommentIndex(0, { scroll: false });
    }
  });
}


// Drop any previously installed service worker / caches so posts always load fresh.
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((reg) => {
      void reg.unregister();
    });
  });
}
if (typeof caches !== "undefined") {
  void caches.keys().then((keys) => {
    keys.forEach((key) => {
      void caches.delete(key);
    });
  });
}
