import DOMPurify from "./vendor/dompurify.es.mjs";

const STORIES_ENDPOINT = "/api/stories";
const ITEM_ENDPOINT = "/api/item";
const PAGE_SIZE = 30;
const INITIAL_PAGE_SIZE = 12;
const COMMENTS_BATCH_SIZE = 30;
const COMMENTS_AUTO_RENDER_LIMIT = 200;
const THREAD_ENDPOINT = "/api/thread";
const FEED_BEST = "best";
const FEED_TOP = "top";
const FEED_NEW = "new";
const FEEDS = [FEED_BEST, FEED_TOP, FEED_NEW];
const LIST_VISIBLE_REFRESH_AFTER_MS = 60 * 1000;
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
let currentFeed = FEED_BEST;
let listHiddenAt = 0;
const commentActionHandlers = new WeakMap();

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

async function fetchThread(id, { signal } = {}) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new Error("Invalid story id.");
  }

  return fetchJSON(`${THREAD_ENDPOINT}?id=${numericId}`, {
    signal,
    errorPrefix: "Thread request failed",
  });
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
  element.dataset.depth = String(safeDepth);
  element.style.setProperty("--comment-depth", String(safeDepth));
}

function normalizeThreadComment(node) {
  if (!node || typeof node !== "object") {
    return null;
  }

  const id = Number(node.id);
  if (!Number.isFinite(id)) {
    return null;
  }

  const time = Number(node.time ?? node.created_at_i);
  const rawKids = Array.isArray(node.kids)
    ? node.kids
    : Array.isArray(node.children)
      ? node.children
      : [];
  const children = rawKids
    .map((child) => normalizeThreadComment(child))
    .filter((child) => child);

  return {
    id,
    by:
      (typeof node.by === "string" && node.by) ||
      (typeof node.author === "string" && node.author) ||
      "unknown",
    time: Number.isFinite(time) ? time : 0,
    text: typeof node.text === "string" ? node.text : "",
    children,
    deleted: Boolean(node.deleted),
    dead: Boolean(node.dead),
  };
}

function normalizeThreadChildren(thread) {
  if (!thread || typeof thread !== "object") {
    return [];
  }

  const rootComments = Array.isArray(thread.comments)
    ? thread.comments
    : Array.isArray(thread.children)
      ? thread.children
      : [];

  return rootComments
    .map((child) => normalizeThreadComment(child))
    .filter((child) => child);
}

function createCommentRenderState({ signal, sectionEl, rootEl, statusEl }) {
  return {
    signal,
    sectionEl,
    rootEl,
    statusEl,
    enqueueRender: createTaskQueue(1, { signal }),
    childLists: new Map(),
    moreItems: new Map(),
    nextListId: 1,
    autoScheduledCount: 0,
    loadedCount: 0,
  };
}

function updateCommentStatus(state) {
  if (!state.statusEl || !state.statusEl.isConnected) {
    return;
  }

  if (state.loadedCount === 0) {
    state.statusEl.textContent = "Loading comments...";
    return;
  }

  state.statusEl.textContent = `Loaded ${state.loadedCount} comments`;
}

function removeLoadMoreControl(model) {
  if (model.controlEl && model.controlEl.isConnected) {
    model.controlEl.remove();
  }
  model.controlEl = null;
}

function renderLoadMoreControl(model, remaining) {
  removeLoadMoreControl(model);

  if (remaining <= 0 || !model.container.isConnected) {
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "comment-actions";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn";
  button.dataset.action = "load-more-children";
  button.dataset.listId = model.id;
  button.textContent = `Load more (${remaining})`;

  wrap.appendChild(button);
  model.container.appendChild(wrap);
  model.controlEl = wrap;
}

function createCommentElement(state, item, depth) {
  const article = document.createElement("article");
  article.className = "comment";
  article.dataset.commentId = String(item.id);
  applyCommentDepth(article, depth);

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
    timeSpan.textContent = item.time ? timeAgo(item.time) + " ago" : "";

    meta.append(bySpan);
    if (timeSpan.textContent) {
      meta.append(timeSpan);
    }
  }

  const actions = document.createElement("div");
  actions.className = "comment-actions";

  // Chevron expand/collapse toggle button — pill-shaped like feed picker
  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "btn comment-toggle-btn";
  toggleButton.dataset.action = "toggle-comment";
  toggleButton.dataset.slot = "toggle";
  toggleButton.innerHTML = `<svg class="comment-chevron" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  toggleButton.setAttribute("aria-label", "Collapse comment");
  toggleButton.title = "Collapse comment";
  actions.appendChild(toggleButton);

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

  const normalizedKids = Array.isArray(item.children)
    ? item.children.filter((child) => child && Number.isFinite(child.id))
    : [];

  if (normalizedKids.length) {
    const repliesButton = document.createElement("button");
    repliesButton.type = "button";
    repliesButton.className = "btn comment-replies-btn";
    repliesButton.dataset.action = "load-replies";
    repliesButton.dataset.slot = "replies";
    repliesButton.dataset.commentId = String(item.id);
    repliesButton.innerHTML = `<svg class="comment-chevron" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="replies-count">${normalizedKids.length}</span>`;
    repliesButton.setAttribute(
      "aria-label",
      `Show ${normalizedKids.length} ${normalizedKids.length === 1 ? "reply" : "replies"}`,
    );
    repliesButton.title = `Show ${normalizedKids.length} ${
      normalizedKids.length === 1 ? "reply" : "replies"
    }`;
    actions.appendChild(repliesButton);

    state.moreItems.set(item.id, {
      id: item.id,
      kids: normalizedKids,
      depth: depth + 1,
      container: children,
      loaded: false,
    });
  }

  article.append(meta, actions, text, children);
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

              items.forEach((item) => {
                fragment.appendChild(createCommentElement(state, item, model.depth));
              });

              model.container.appendChild(fragment);
              state.loadedCount += items.length;
              updateCommentStatus(state);

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
    return;
  }

  let count = Math.min(COMMENTS_BATCH_SIZE, remaining);
  if (model.auto && !manual) {
    const budgetLeft = COMMENTS_AUTO_RENDER_LIMIT - state.autoScheduledCount;
    count = Math.min(count, Math.max(0, budgetLeft));
  }

  if (count <= 0) {
    renderLoadMoreControl(model, remaining);
    return;
  }

  const batch = model.items.slice(model.nextIndex, model.nextIndex + count);

  model.nextIndex += count;
  if (model.auto && !manual) {
    state.autoScheduledCount += count;
  }

  void queueCommentBatchRender(state, model, batch).then(() => {
    if (state.signal.aborted || !model.container?.isConnected) {
      return;
    }
    const remainingAfter = model.items.length - model.nextIndex;
    if (remainingAfter > 0) {
      renderLoadMoreControl(model, remainingAfter);
    }
  });
}

function mountChildList(state, container, comments, depth, { auto = true } = {}) {
  const normalizedComments = Array.isArray(comments)
    ? comments.filter((comment) => comment && Number.isFinite(comment.id))
    : [];
  if (!normalizedComments.length || !container?.isConnected) {
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
  };

  state.childLists.set(listId, model);
  container.dataset.listId = listId;

  loadChildBatch(state, model, { manual: !auto });
}

function wireCommentActions(state) {
  const previousHandler = commentActionHandlers.get(state.sectionEl);
  if (previousHandler) {
    state.sectionEl.removeEventListener("click", previousHandler);
  }

  const clickHandler = (event) => {
    const actionEl = event.target.closest("[data-action]");
    if (!actionEl || !state.sectionEl.contains(actionEl)) {
      return;
    }

    const action = actionEl.getAttribute("data-action");
    if (!action) {
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

    if (action === "load-more-item") {
      const commentId = Number(actionEl.getAttribute("data-comment-id"));
      if (!Number.isFinite(commentId)) {
        return;
      }
      const model = state.moreItems.get(commentId);
      if (!model || model.loaded) {
        return;
      }

      model.loaded = true;
      mountChildList(state, model.container, model.kids, model.depth, { auto: false });

      const actionWrap = actionEl.closest(".comment-actions");
      if (actionWrap) {
        actionWrap.remove();
      }
      return;
    }

    if (action === "load-replies") {
      const commentId = Number(actionEl.getAttribute("data-comment-id"));
      if (!Number.isFinite(commentId)) return;
      const model = state.moreItems.get(commentId);
      if (!model || model.loaded) return;

      model.loaded = true;
      mountChildList(state, model.container, model.kids, model.depth, { auto: false });
      // Rotate chevron to show "open" state instead of removing the button
      actionEl.classList.add("is-open");
      actionEl.setAttribute("aria-label", "Replies loaded");
      actionEl.disabled = true;
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
      actionEl.title = nextLabel;
      // Chevron rotation is handled by CSS via .is-collapsed on the parent .comment
    }
  };

  state.sectionEl.addEventListener("click", clickHandler);
  commentActionHandlers.set(state.sectionEl, clickHandler);
}

async function renderStoryPage(id) {
  const storyId = Number(id);
  app.dataset.view = "story";
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
      <article class="story story-detail">
        <div class="story-title">loading story...</div>
        <div class="story-meta"><span class="status">fetching story details...</span></div>
      </article>
      <section class="comments" aria-live="polite">
        <h2 class="comments-title">Comments</h2>
        <p class="status" data-comments-status>Loading comments...</p>
        <div class="comment-children" data-comments-root></div>
      </section>
    </section>
  `;
  wireThemeToggle();
  wireFeedToggleButtons();

  const detailSlot = app.querySelector(".story-detail");
  const commentsSection = app.querySelector(".comments");
  const commentsRoot = app.querySelector("[data-comments-root]");
  const commentsStatus = app.querySelector("[data-comments-status]");

  if (!detailSlot || !commentsSection || !commentsRoot || !commentsStatus) {
    return;
  }

  // Thread endpoint includes story metadata + nested comments (Algolia shape).
  let thread = null;
  try {
    thread = await fetchThread(storyId, { signal: controller.signal });
  } catch (error) {
    if (
      isAbortError(error) ||
      controller.signal.aborted ||
      currentViewController !== controller
    ) {
      return;
    }

    detailSlot.innerHTML = `
      <div class="story-title">failed to load story</div>
      <div class="story-meta"><span>${escapeHTML(error.message)}</span></div>
    `;
    commentsStatus.textContent = "Could not load comments.";
    return;
  }

  if (controller.signal.aborted || currentViewController !== controller) {
    return;
  }

  if (!thread || !normalizeStoryDetail(thread)) {
    detailSlot.innerHTML = `
      <div class="story-title">story not found</div>
    `;
    commentsStatus.textContent = "No comments available.";
    return;
  }

  const renderedStory = createElementFromHTML(renderStoryDetail(thread));
  if (renderedStory) {
    detailSlot.replaceWith(renderedStory);
  }

  const commentState = createCommentRenderState({
    signal: controller.signal,
    sectionEl: commentsSection,
    rootEl: commentsRoot,
    statusEl: commentsStatus,
  });

  wireCommentActions(commentState);

  const threadComments = normalizeThreadChildren(thread);
  if (!threadComments.length) {
    commentsStatus.textContent = "No comments yet.";
    return;
  }

  mountChildList(commentState, commentState.rootEl, threadComments, 0, { auto: true });
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
