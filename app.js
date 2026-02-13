const API_BASE = "https://hacker-news.firebaseio.com/v0";
const PAGE_SIZE = 30;
const MAX_CONCURRENCY = 8;
const ITEM_TTL_MS = 3 * 60 * 1000;
const ITEM_CACHE_STORAGE_KEY = "hn-fork:item-cache:v1";
const THEME_STORAGE_KEY = "hn-fork:theme:v1";
const ITEM_CACHE_MAX_ENTRIES = 1200;
const ITEM_CACHE_PERSIST_MAX_ENTRIES = 280;
const COMMENTS_BATCH_SIZE = 20;
const COMMENTS_AUTO_RENDER_LIMIT = 200;
const PREVIEW_HASH_PREFIX = "p=";
const PREVIEW_BLOCK_TIMEOUT_MS = 2500;
const PREVIEW_EMBED_BLOCKED_MESSAGE =
  "This site may block embedding. Use Open in new tab.";
const READER_ENDPOINT = "/api/reader";
const READABILITY_MODULE_URL = "https://esm.sh/@mozilla/readability@0.5.0?bundle";
const THEME_TERMINAL = "terminal";
const THEME_BLOOMBERG = "bloomberg";
const app = document.getElementById("app");
app?.classList.add("shell");

const store = {
  bestStoryIds: [],
  itemCache: new Map(),
  itemCacheLoaded: false,
};

const unescape = document.createElement("textarea");
let currentViewController = null;
let persistItemCacheTimer = null;
let selectedStoryIndex = -1;
let listKeyboardHandler = null;
let activeListPage = 1;
let currentTheme = THEME_TERMINAL;
const previewState = {
  activeUrl: "",
  loadToken: 0,
  blockedTimer: null,
  readerController: null,
  mode: "embed",
};
let readabilityModulePromise = null;

applyTheme(loadSavedTheme());
window.addEventListener("hashchange", handleRouteChange);
window.addEventListener("load", handleRouteChange);
document.addEventListener("keydown", handleGlobalKeydown);

async function handleRouteChange() {
  const route = parseRoute();

  if (canHandleRouteInPlace(route)) {
    applyListRoute(route);
    return;
  }

  await renderRoute(route);
}

async function renderRoute(route = parseRoute()) {
  abortCurrentViewLoad();
  teardownListSelection();
  closePreview({ updateHash: false });
  app.classList.remove("is-preview-open");
  app.dataset.view = "";
  app.innerHTML = "";

  if (route.type === "story") {
    await renderStoryPage(route.id);
    return;
  }

  const targetPage = route.type === "preview" ? activeListPage : route.page;
  await renderListPage(targetPage);
  applyListRoute(route);
}

function canHandleRouteInPlace(route) {
  if (app.dataset.view !== "list") {
    return false;
  }

  if (route.type === "preview") {
    return true;
  }

  if (route.type !== "list") {
    return false;
  }

  const hash = window.location.hash.replace(/^#/, "").trim();
  if (!hash || hash === "/" || route.page === activeListPage) {
    return true;
  }

  return false;
}

function applyListRoute(route) {
  if (route.type === "preview") {
    openPreviewByUrl(route.url, { updateHash: false });
    return;
  }

  closePreview({ updateHash: false });
}

function parseRoute() {
  const hash = window.location.hash.replace(/^#/, "").trim();

  if (!hash || hash === "/") {
    return { type: "list", page: 1 };
  }

  const pageMatch = hash.match(/^\/page\/(\d+)$/);
  if (pageMatch) {
    return { type: "list", page: Math.max(1, Number(pageMatch[1])) };
  }

  const previewMatch = hash.match(/^p=(.+)$/);
  if (previewMatch) {
    try {
      const decoded = decodeURIComponent(previewMatch[1]);
      const safeUrl = getSafeUrl(decoded);
      if (safeUrl) {
        return { type: "preview", url: safeUrl };
      }
    } catch {}
    return { type: "list", page: 1 };
  }

  const storyMatch = hash.match(/^\/(?:item|story)\/(\d+)$/);
  if (storyMatch) {
    return { type: "story", id: Number(storyMatch[1]) };
  }

  const queryStoryMatch = hash.match(/^\/item\?id=(\d+)$/);
  if (queryStoryMatch) {
    return { type: "story", id: Number(queryStoryMatch[1]) };
  }

  return { type: "list", page: 1 };
}

function escapeHTML(value) {
  unescape.textContent = value ?? "";
  return unescape.innerHTML;
}

function normalizeTheme(theme) {
  return theme === THEME_BLOOMBERG ? THEME_BLOOMBERG : THEME_TERMINAL;
}

function loadSavedTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return normalizeTheme(saved);
  } catch {
    return THEME_TERMINAL;
  }
}

function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, normalizeTheme(theme));
  } catch {}
}

function getThemeLabel(theme = currentTheme) {
  return theme === THEME_BLOOMBERG ? "Theme: Bloomberg" : "Theme: Terminal";
}

function updateThemeToggleLabels() {
  const label = getThemeLabel();
  app.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    button.textContent = label;
    button.setAttribute("aria-label", label);
  });
}

function applyTheme(theme, { persist = false } = {}) {
  currentTheme = normalizeTheme(theme);
  document.documentElement.dataset.theme = currentTheme;
  if (persist) {
    saveTheme(currentTheme);
  }
  updateThemeToggleLabels();
}

function toggleTheme() {
  const next = currentTheme === THEME_BLOOMBERG ? THEME_TERMINAL : THEME_BLOOMBERG;
  applyTheme(next, { persist: true });
}

function wireThemeToggleButtons(root = app) {
  root.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    if (button.dataset.wired) {
      return;
    }
    button.dataset.wired = "true";
    button.addEventListener("click", () => {
      toggleTheme();
    });
  });
  updateThemeToggleLabels();
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

function previewHashForUrl(url) {
  return `#${PREVIEW_HASH_PREFIX}${encodeURIComponent(url)}`;
}

function clearPreviewBlockedTimer() {
  if (previewState.blockedTimer) {
    window.clearTimeout(previewState.blockedTimer);
    previewState.blockedTimer = null;
  }
}

function clearPreviewReaderController() {
  if (previewState.readerController) {
    previewState.readerController.abort();
    previewState.readerController = null;
  }
}

function getPreviewElements() {
  const pane = app.querySelector("[data-preview-pane]");
  if (!pane) {
    return null;
  }

  const titleEl = pane.querySelector("[data-preview-title]");
  const domainEl = pane.querySelector("[data-preview-domain]");
  const closeButton = pane.querySelector("[data-preview-close]");
  const readerButton = pane.querySelector("[data-preview-reader]");
  const openLink = pane.querySelector("[data-preview-open]");
  const iframe = pane.querySelector("[data-preview-frame]");
  const loading = pane.querySelector("[data-preview-loading]");
  const reader = pane.querySelector("[data-preview-reader-content]");
  const fallback = pane.querySelector("[data-preview-fallback]");

  if (
    !titleEl ||
    !domainEl ||
    !closeButton ||
    !readerButton ||
    !openLink ||
    !iframe ||
    !loading ||
    !reader ||
    !fallback
  ) {
    return null;
  }

  return {
    pane,
    titleEl,
    domainEl,
    closeButton,
    readerButton,
    openLink,
    iframe,
    loading,
    reader,
    fallback,
  };
}

function getPreviewDataFromLink(link) {
  if (!link) {
    return null;
  }

  const url = getSafeUrl(link.dataset.previewUrl || link.getAttribute("href"));
  if (!url) {
    return null;
  }

  const title = (link.dataset.previewTitle || link.textContent || "").trim();
  const domain = (link.dataset.previewDomain || getDomain(url) || "").trim();
  return { url, title, domain, row: link.closest(".story") };
}

function findStoryLinkByPreviewUrl(url) {
  const safeUrl = getSafeUrl(url);
  if (!safeUrl) {
    return null;
  }

  const links = app.querySelectorAll(".story-list .story-title a[data-preview-url]");
  for (const link of links) {
    if (getSafeUrl(link.dataset.previewUrl) === safeUrl) {
      return link;
    }
  }
  return null;
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

function setPreviewFallbackMessage(elements, message = "", { kind = "info" } = {}) {
  const trimmed = (message || "").trim();
  elements.fallback.textContent = trimmed;
  elements.fallback.dataset.kind = trimmed ? kind : "";
  elements.fallback.hidden = !trimmed;
}

function setPreviewLoadingVisible(elements, visible, message = "Loading preview...") {
  elements.loading.hidden = !visible;
  elements.loading.textContent = message;
}

function setPreviewMode(elements, mode) {
  const normalizedMode = mode === "reader" ? "reader" : "embed";
  previewState.mode = normalizedMode;
  elements.reader.hidden = normalizedMode !== "reader";
  elements.iframe.hidden = normalizedMode === "reader";
  elements.readerButton.setAttribute("aria-pressed", normalizedMode === "reader" ? "true" : "false");
  elements.readerButton.textContent = normalizedMode === "reader" ? "Web View" : "Reader View";
}

function setPreviewReaderButtonLoading(elements, loading) {
  elements.readerButton.disabled = loading;
  if (loading) {
    elements.readerButton.textContent = "Loading Reader...";
  } else {
    elements.readerButton.textContent = previewState.mode === "reader" ? "Web View" : "Reader View";
  }
}

function clearPreviewReaderContent(elements) {
  elements.reader.replaceChildren();
}

function isFrameUsable(iframe) {
  try {
    const href = iframe.contentWindow?.location?.href || "";
    return Boolean(href && href !== "about:blank" && href !== "about:srcdoc");
  } catch {
    return true;
  }
}

function getSafeResolvedUrl(value, baseUrl = "") {
  if (!value) {
    return null;
  }
  try {
    const parsed = baseUrl ? new URL(value, baseUrl) : new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

async function getReadabilityCtor() {
  if (!readabilityModulePromise) {
    readabilityModulePromise = import(READABILITY_MODULE_URL).catch((error) => {
      readabilityModulePromise = null;
      throw error;
    });
  }

  const module = await readabilityModulePromise;
  const candidate = module?.Readability ?? module?.default?.Readability ?? module?.default;
  if (typeof candidate !== "function") {
    throw new Error("Readability is unavailable.");
  }
  return candidate;
}

function setReaderViewError(elements, message) {
  clearPreviewReaderContent(elements);
  const errorEl = document.createElement("p");
  errorEl.className = "preview-reader-error";
  errorEl.textContent = message;
  elements.reader.appendChild(errorEl);
}

async function openReaderView() {
  const elements = getPreviewElements();
  if (!elements) {
    return;
  }

  const safeUrl = getSafeUrl(previewState.activeUrl);
  if (!safeUrl) {
    return;
  }

  const protocol = new URL(safeUrl).protocol;
  if (protocol !== "https:") {
    setPreviewMode(elements, "embed");
    setPreviewReaderButtonLoading(elements, false);
    setPreviewLoadingVisible(elements, false);
    setPreviewFallbackMessage(
      elements,
      "Reader View only supports https links. Use Open in new tab.",
      { kind: "warning" },
    );
    return;
  }

  clearPreviewBlockedTimer();
  clearPreviewReaderController();
  const token = previewState.loadToken;
  const controller = new AbortController();
  previewState.readerController = controller;

  setPreviewMode(elements, "reader");
  clearPreviewReaderContent(elements);
  setPreviewFallbackMessage(elements, "");
  setPreviewLoadingVisible(elements, true, "Loading Reader View...");
  setPreviewReaderButtonLoading(elements, true);

  try {
    const response = await fetch(`${READER_ENDPOINT}?url=${encodeURIComponent(safeUrl)}`, {
      signal: controller.signal,
      headers: {
        Accept: "text/plain",
      },
    });

    if (!response.ok) {
      throw new Error(`Reader request failed (${response.status}).`);
    }

    const html = await response.text();
    if (
      token !== previewState.loadToken ||
      controller !== previewState.readerController ||
      safeUrl !== previewState.activeUrl
    ) {
      return;
    }

    const finalUrl = response.headers.get("x-reader-final-url") || safeUrl;
    const readabilityDocument = new DOMParser().parseFromString(html, "text/html");
    if (readabilityDocument.head) {
      const base = readabilityDocument.createElement("base");
      base.href = finalUrl;
      readabilityDocument.head.prepend(base);
    }

    const Readability = await getReadabilityCtor();
    const article = new Readability(readabilityDocument).parse();

    if (!article || (!article.content && !article.textContent)) {
      throw new Error("No readable content was extracted.");
    }

    const safeContent = sanitizeReaderHTML(article.content || "", finalUrl);
    if (!safeContent && article.textContent) {
      const body = document.createElement("div");
      body.className = "preview-reader-body";
      body.textContent = article.textContent.trim();
      elements.reader.replaceChildren(body);
    } else if (!safeContent) {
      throw new Error("No readable content was extracted.");
    } else {
      elements.reader.innerHTML = `
        <article class="preview-reader-article">
          <h3 class="preview-reader-title">${escapeHTML(article.title || "Reader View")}</h3>
          ${article.excerpt ? `<p class="preview-reader-excerpt">${escapeHTML(article.excerpt)}</p>` : ""}
          <div class="preview-reader-body">${safeContent}</div>
        </article>
      `;
    }

    setPreviewFallbackMessage(elements, "");
  } catch (error) {
    if (isAbortError(error) || controller.signal.aborted) {
      return;
    }
    if (
      token !== previewState.loadToken ||
      controller !== previewState.readerController ||
      safeUrl !== previewState.activeUrl
    ) {
      return;
    }
    setReaderViewError(elements, "Reader View could not extract this page.");
    setPreviewFallbackMessage(elements, "Reader View failed. Use Open in new tab.", {
      kind: "warning",
    });
  } finally {
    if (controller === previewState.readerController) {
      previewState.readerController = null;
    }
    if (token === previewState.loadToken) {
      setPreviewLoadingVisible(elements, false);
      setPreviewReaderButtonLoading(elements, false);
    }
  }
}

function toggleReaderView() {
  const elements = getPreviewElements();
  if (!elements || !previewState.activeUrl) {
    return;
  }

  if (previewState.mode === "reader") {
    clearPreviewReaderController();
    openPreviewByUrl(previewState.activeUrl, { updateHash: false });
    return;
  }

  openReaderView();
}

function openPreview(preview, { updateHash = false } = {}) {
  if (!preview?.url) {
    return false;
  }

  const safeUrl = getSafeUrl(preview.url);
  if (!safeUrl) {
    return false;
  }

  const elements = getPreviewElements();
  if (!elements) {
    return false;
  }

  const title = (preview.title || safeUrl).trim();
  const domain = (preview.domain || getDomain(safeUrl) || "").trim();

  clearPreviewBlockedTimer();
  clearPreviewReaderController();
  previewState.loadToken += 1;
  const token = previewState.loadToken;

  elements.titleEl.textContent = title;
  elements.domainEl.textContent = domain;
  elements.openLink.href = safeUrl;
  elements.pane.classList.add("is-open");
  elements.pane.setAttribute("aria-hidden", "false");
  setPreviewMode(elements, "embed");
  setPreviewReaderButtonLoading(elements, false);
  clearPreviewReaderContent(elements);

  const protocol = new URL(safeUrl).protocol;
  if (protocol === "http:") {
    setPreviewLoadingVisible(elements, false);
    setPreviewFallbackMessage(
      elements,
      "This link uses http:// and cannot be embedded on an https page. Use Open in new tab.",
      { kind: "warning" },
    );
    elements.iframe.onload = null;
    elements.iframe.onerror = null;
    elements.iframe.removeAttribute("src");
  } else {
    setPreviewFallbackMessage(elements, "");
    setPreviewLoadingVisible(elements, true, "Loading preview...");

    elements.iframe.onload = () => {
      if (token !== previewState.loadToken || previewState.mode !== "embed") {
        return;
      }
      clearPreviewBlockedTimer();
      setPreviewLoadingVisible(elements, false);
      if (isFrameUsable(elements.iframe)) {
        setPreviewFallbackMessage(elements, "");
      } else {
        setPreviewFallbackMessage(elements, PREVIEW_EMBED_BLOCKED_MESSAGE, { kind: "warning" });
      }
    };

    elements.iframe.onerror = () => {
      if (token !== previewState.loadToken || previewState.mode !== "embed") {
        return;
      }
      clearPreviewBlockedTimer();
      setPreviewLoadingVisible(elements, false);
      setPreviewFallbackMessage(elements, PREVIEW_EMBED_BLOCKED_MESSAGE, { kind: "warning" });
    };

    elements.iframe.src = safeUrl;
    previewState.blockedTimer = window.setTimeout(() => {
      if (token !== previewState.loadToken || previewState.mode !== "embed") {
        return;
      }
      setPreviewLoadingVisible(elements, false);
      setPreviewFallbackMessage(elements, PREVIEW_EMBED_BLOCKED_MESSAGE, { kind: "warning" });
    }, PREVIEW_BLOCK_TIMEOUT_MS);
  }

  previewState.activeUrl = safeUrl;
  app.classList.add("is-preview-open");

  if (preview.row) {
    setSelectedStoryElement(preview.row);
  }

  if (updateHash) {
    const nextHash = previewHashForUrl(safeUrl);
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
  }

  return true;
}

function openPreviewByUrl(url, { updateHash = false } = {}) {
  const safeUrl = getSafeUrl(url);
  if (!safeUrl) {
    closePreview({ updateHash: false });
    return false;
  }

  const matchedLink = findStoryLinkByPreviewUrl(safeUrl);
  const linkedPreview = matchedLink
    ? getPreviewDataFromLink(matchedLink)
    : {
        url: safeUrl,
        title: safeUrl,
        domain: getDomain(safeUrl),
        row: null,
      };

  return openPreview(linkedPreview, { updateHash });
}

function closePreview({ updateHash = false } = {}) {
  clearPreviewBlockedTimer();
  clearPreviewReaderController();
  previewState.loadToken += 1;
  previewState.activeUrl = "";
  previewState.mode = "embed";

  const elements = getPreviewElements();
  if (elements) {
    elements.pane.classList.remove("is-open");
    elements.pane.setAttribute("aria-hidden", "true");
    elements.titleEl.textContent = "Story preview";
    elements.domainEl.textContent = "";
    elements.openLink.removeAttribute("href");
    setPreviewMode(elements, "embed");
    setPreviewReaderButtonLoading(elements, false);
    clearPreviewReaderContent(elements);
    setPreviewLoadingVisible(elements, false);
    setPreviewFallbackMessage(elements, "");
    elements.iframe.onload = null;
    elements.iframe.onerror = null;
    elements.iframe.removeAttribute("src");
  }

  app.classList.remove("is-preview-open");

  if (updateHash && window.location.hash.startsWith(`#${PREVIEW_HASH_PREFIX}`)) {
    window.location.hash = "";
  }
}

function handleGlobalKeydown(event) {
  if (event.defaultPrevented || event.key !== "Escape") {
    return;
  }

  if (!app.classList.contains("is-preview-open")) {
    return;
  }

  event.preventDefault();
  closePreview({ updateHash: true });
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

function isEditableTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }

  if (target.closest("input, textarea, select, button")) {
    return true;
  }

  return target.closest('[contenteditable=""], [contenteditable="true"]') !== null;
}

function openSelectedStory() {
  const link = getSelectedStoryLink();
  if (!link) {
    return;
  }

  const preview = getPreviewDataFromLink(link);
  if (preview) {
    openPreview(preview, { updateHash: true });
    return;
  }

  const path = getStoryNavigationPath(link);
  if (path) {
    navigateTo(path);
    return;
  }

  link.click();
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

async function fetchJSON(path, { signal } = {}) {
  const response = await fetch(`${API_BASE}/${path}`, { signal });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

async function mapWithConcurrency(items, limit, asyncFn, { signal } = {}) {
  if (!items.length) {
    return [];
  }
  if (signal?.aborted) {
    throw createAbortError();
  }

  const results = new Array(items.length);
  const workerCount = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;

  async function worker() {
    while (true) {
      if (signal?.aborted) {
        throw createAbortError();
      }

      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await asyncFn(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
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

async function getBestStoryIds({ signal } = {}) {
  if (store.bestStoryIds.length) {
    return store.bestStoryIds;
  }
  const ids = await fetchJSON("beststories.json", { signal });
  store.bestStoryIds = Array.isArray(ids) ? ids : [];
  return store.bestStoryIds;
}

function pruneItemCache() {
  const now = Date.now();
  const alive = [];

  store.itemCache.forEach((entry, id) => {
    if (!entry || typeof entry.ts !== "number" || now - entry.ts >= ITEM_TTL_MS) {
      store.itemCache.delete(id);
      return;
    }
    alive.push([id, entry]);
  });

  if (alive.length <= ITEM_CACHE_MAX_ENTRIES) {
    return;
  }

  alive.sort((a, b) => b[1].ts - a[1].ts);
  for (let index = ITEM_CACHE_MAX_ENTRIES; index < alive.length; index += 1) {
    store.itemCache.delete(alive[index][0]);
  }
}

function loadItemCacheFromStorage() {
  if (store.itemCacheLoaded) {
    return;
  }
  store.itemCacheLoaded = true;

  try {
    const raw = localStorage.getItem(ITEM_CACHE_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : parsed?.items;
    const now = Date.now();

    if (!Array.isArray(items)) {
      return;
    }

    items.forEach((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) {
        return;
      }
      const [id, value] = entry;
      const numericId = Number(id);
      if (!Number.isFinite(numericId) || !value || typeof value.ts !== "number") {
        return;
      }
      if (now - value.ts >= ITEM_TTL_MS) {
        return;
      }
      store.itemCache.set(numericId, {
        data: value.data ?? null,
        ts: value.ts,
      });
    });

    pruneItemCache();
  } catch {}
}

function persistItemCacheToStorage() {
  try {
    pruneItemCache();

    const entries = [];
    store.itemCache.forEach((entry, id) => {
      entries.push([id, entry]);
    });

    entries.sort((a, b) => b[1].ts - a[1].ts);
    const limited = entries.slice(0, ITEM_CACHE_PERSIST_MAX_ENTRIES);
    localStorage.setItem(ITEM_CACHE_STORAGE_KEY, JSON.stringify(limited));
  } catch {}
}

function schedulePersistItemCache() {
  if (persistItemCacheTimer) {
    return;
  }
  persistItemCacheTimer = window.setTimeout(() => {
    persistItemCacheTimer = null;
    persistItemCacheToStorage();
  }, 180);
}

function readItemFromCache(id) {
  loadItemCacheFromStorage();
  const entry = store.itemCache.get(id);
  if (!entry) {
    return { hit: false, data: null };
  }

  if (Date.now() - entry.ts >= ITEM_TTL_MS) {
    store.itemCache.delete(id);
    schedulePersistItemCache();
    return { hit: false, data: null };
  }

  return { hit: true, data: entry.data };
}

function writeItemToCache(id, data) {
  loadItemCacheFromStorage();
  store.itemCache.set(id, { data, ts: Date.now() });
  pruneItemCache();
  schedulePersistItemCache();
}

async function getItem(id, { signal, forceRefresh = false } = {}) {
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) {
    return null;
  }

  if (!forceRefresh) {
    const cached = readItemFromCache(numericId);
    if (cached.hit) {
      return cached.data;
    }
  }

  const item = await fetchJSON(`item/${numericId}.json`, { signal });
  writeItemToCache(numericId, item ?? null);
  return item;
}

async function getItems(ids, { signal, onItem, forceRefresh = false } = {}) {
  const normalizedIds = normalizeIds(ids);
  return mapWithConcurrency(
    normalizedIds,
    MAX_CONCURRENCY,
    async (id, index) => {
      try {
        const item = await getItem(id, { signal, forceRefresh });
        onItem?.({ id, index, data: item, error: null });
        return item;
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        onItem?.({ id, index, data: null, error });
        return null;
      }
    },
    { signal },
  );
}

function normalizeIds(ids) {
  if (!Array.isArray(ids)) {
    return [];
  }
  return ids
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));
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
      <a class="brand" href="#/">HNx</a>
      <div class="topbar-actions">
        ${rightContent}
        <button class="btn theme-toggle" type="button" data-theme-toggle>
          ${getThemeLabel()}
        </button>
      </div>
    </header>
  `;
}

function loadingPager(page) {
  return `
    <nav class="pager" aria-label="Pagination">
      <button class="btn" disabled>prev</button>
      <span>${Math.max(1, page)}/...</span>
      <button class="btn" disabled>next</button>
    </nav>
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
  row.innerHTML = `
    <div class="story-title">${index}. ${message}</div>
    <div class="story-meta"><span>fetching story details...</span></div>
  `;
  return row;
}

function renderLoadingRows(listEl, count, startIndex) {
  const slots = [];
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < count; i += 1) {
    const row = createLoadingRow(startIndex + i + 1);
    row.dataset.slot = String(i);
    slots.push(row);
    fragment.appendChild(row);
  }

  listEl.replaceChildren(fragment);
  return slots;
}

function renderFailedStoryRow(id, index, slotIndex) {
  return `
    <article class="story" data-slot="${slotIndex}">
      <div class="story-title">${index}. failed to load</div>
      <div class="story-meta">
        <span>item ${id}</span>
        <span><button class="btn" type="button" data-retry-id="${id}" data-retry-slot="${slotIndex}">retry</button></span>
      </div>
    </article>
  `;
}

async function renderListPage(page) {
  const controller = new AbortController();
  currentViewController = controller;

  try {
    app.dataset.view = "list";
    app.innerHTML = `
      <section class="list-pane">
        ${topbar(loadingPager(page))}
        <section class="story-list"></section>
      </section>
      <aside class="preview-pane" data-preview-pane aria-hidden="true">
        <article class="preview-card">
          <header class="preview-header">
            <div class="preview-heading">
              <h2 class="preview-title" data-preview-title>Story preview</h2>
              <span class="preview-domain" data-preview-domain></span>
            </div>
            <div class="preview-actions">
              <button class="btn" type="button" data-preview-close>Close</button>
              <button class="btn" type="button" data-preview-reader aria-pressed="false">
                Reader View
              </button>
              <a
                class="btn"
                data-preview-open
                href=""
                target="_blank"
                rel="noopener noreferrer"
              >Open in new tab</a>
            </div>
          </header>
          <div class="preview-frame-wrap">
            <iframe
              class="preview-frame"
              data-preview-frame
              loading="lazy"
              referrerpolicy="strict-origin-when-cross-origin"
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
              title="Story preview"
            ></iframe>
            <p class="preview-loading" data-preview-loading hidden>Loading preview...</p>
            <article class="preview-reader" data-preview-reader-content hidden></article>
            <p class="preview-fallback" data-preview-fallback hidden>
              This site may block embedding. Use Open in new tab.
            </p>
          </div>
        </article>
      </aside>
    `;
    wireThemeToggleButtons();

    const listEl = app.querySelector(".story-list");
    if (!listEl) {
      return;
    }

    const closePreviewButton = app.querySelector("[data-preview-close]");
    if (closePreviewButton && !closePreviewButton.dataset.wired) {
      closePreviewButton.dataset.wired = "true";
      closePreviewButton.addEventListener("click", () => {
        closePreview({ updateHash: true });
      });
    }

    const readerViewButton = app.querySelector("[data-preview-reader]");
    if (readerViewButton && !readerViewButton.dataset.wired) {
      readerViewButton.dataset.wired = "true";
      readerViewButton.addEventListener("click", () => {
        toggleReaderView();
      });
    }

    let start = (Math.max(1, page) - 1) * PAGE_SIZE;
    let slots = renderLoadingRows(listEl, PAGE_SIZE, start);
    initializeListSelection(listEl);
    applyListRoute(parseRoute());

    const ids = await getBestStoryIds({ signal: controller.signal });
    if (controller.signal.aborted || currentViewController !== controller) {
      return;
    }

    const totalPages = Math.max(1, Math.ceil(ids.length / PAGE_SIZE));
    const safePage = Math.min(Math.max(1, page), totalPages);
    activeListPage = safePage;
    start = (safePage - 1) * PAGE_SIZE;
    const pageIds = ids.slice(start, start + PAGE_SIZE);

    const nextTopbar = createElementFromHTML(topbar(pager(safePage, totalPages)));
    const currentTopbar = app.querySelector(".topbar");
    if (nextTopbar && currentTopbar) {
      currentTopbar.replaceWith(nextTopbar);
      wirePagination();
      wireThemeToggleButtons();
    }

    if (!pageIds.length) {
      listEl.innerHTML = '<p class="status">No stories available.</p>';
      return;
    }

    slots = renderLoadingRows(listEl, pageIds.length, start);
    initializeListSelection(listEl);

    const replaceSlot = (slotIndex, html) => {
      const current = slots[slotIndex];
      if (!current || !current.isConnected) {
        return;
      }
      const next = createElementFromHTML(html);
      if (!next) {
        return;
      }
      current.replaceWith(next);
      slots[slotIndex] = next;
      applyListSelection({ scroll: false });
      applyListRoute(parseRoute());
    };

    listEl.addEventListener("click", async (event) => {
      const titleLink = event.target.closest(".story-title a");
      if (titleLink && listEl.contains(titleLink)) {
        event.preventDefault();
        const preview = getPreviewDataFromLink(titleLink);
        if (preview) {
          if (preview.row) {
            setSelectedStoryElement(preview.row);
          }
          openPreview(preview, { updateHash: true });
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
      const slotIndex = Number(retryButton.getAttribute("data-retry-slot"));
      if (!Number.isFinite(id) || !Number.isInteger(slotIndex)) {
        return;
      }

      const loadingRow = createLoadingRow(start + slotIndex + 1, "retrying...");
      const slot = slots[slotIndex];
      if (!slot || !slot.isConnected) {
        return;
      }
      slot.replaceWith(loadingRow);
      slots[slotIndex] = loadingRow;

      let story = null;
      try {
        [story] = await getItems([id], {
          signal: controller.signal,
          forceRefresh: true,
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
        replaceSlot(slotIndex, renderStoryRow(story, start + slotIndex + 1));
        return;
      }

      replaceSlot(slotIndex, renderFailedStoryRow(id, start + slotIndex + 1, slotIndex));
    });

    await getItems(pageIds, {
      signal: controller.signal,
      onItem: ({ id, index, data }) => {
        if (controller.signal.aborted || currentViewController !== controller) {
          return;
        }
        if (data) {
          replaceSlot(index, renderStoryRow(data, start + index + 1));
          return;
        }
        replaceSlot(index, renderFailedStoryRow(id, start + index + 1, index));
      },
    });
  } catch (error) {
    if (
      isAbortError(error) ||
      controller.signal.aborted ||
      currentViewController !== controller
    ) {
      return;
    }
    app.innerHTML = `
      ${topbar("")}
      <p class="status">Could not load stories: ${escapeHTML(error.message)}</p>
    `;
    wireThemeToggleButtons();
  }
}

function pager(page, totalPages) {
  return `
    <nav class="pager" aria-label="Pagination">
      <button class="btn" ${page <= 1 ? "disabled" : ""} data-page="${page - 1}">prev</button>
      <span>${page}/${totalPages}</span>
      <button class="btn" ${page >= totalPages ? "disabled" : ""} data-page="${page + 1}">next</button>
    </nav>
  `;
}

function renderStoryRow(story, index) {
  if (!story) {
    return "";
  }

  const domain = getDomain(story.url);
  const safeUrl = getSafeUrl(story.url);
  const previewUrl = safeUrl || `https://news.ycombinator.com/item?id=${story.id}`;
  const previewDomain = domain || getDomain(previewUrl);
  const commentsCount = story.descendants ?? 0;
  const localCommentsUrl = `#/item/${story.id}`;
  const storyTitleRaw = story.title || "Untitled";
  const storyTitle = escapeHTML(storyTitleRaw);
  const escapedPreviewUrl = escapeHTML(previewUrl);
  const titleContent = `
    <a
      href="${escapedPreviewUrl}"
      data-preview-url="${escapedPreviewUrl}"
      data-preview-title="${escapeHTML(storyTitleRaw)}"
      data-preview-domain="${escapeHTML(previewDomain)}"
      data-story-id="${story.id}"
    >${index}. ${storyTitle}</a>
  `;

  return `
    <article class="story" data-preview-url="${escapedPreviewUrl}">
      <div class="story-title">
        ${titleContent}
        ${domain ? `<span class="domain">(${escapeHTML(domain)})</span>` : ""}
      </div>
      <div class="story-meta">
        <span class="meta-points">${story.score ?? 0} points</span>
        <span class="meta-user">by ${escapeHTML(story.by || "unknown")}</span>
        <span class="meta-time">${timeAgo(story.time)} ago</span>
        <span class="meta-comments"><a href="${localCommentsUrl}">${commentsCount} comments</a></span>
      </div>
    </article>
  `;
}

function wirePagination() {
  app.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      const page = button.getAttribute("data-page");
      if (!page) return;
      window.location.hash = `/page/${page}`;
    });
  });
}

const SANITIZE_ALLOWED_TAGS = new Set([
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
]);

function unwrapElement(element) {
  const parent = element.parentNode;
  if (!parent) {
    return;
  }
  while (element.firstChild) {
    parent.insertBefore(element.firstChild, element);
  }
  parent.removeChild(element);
}

function sanitizeHNHTML(value) {
  const template = document.createElement("template");
  template.innerHTML = value ?? "";

  const elements = Array.from(template.content.querySelectorAll("*"));
  for (const element of elements) {
    const tag = element.tagName.toLowerCase();

    if (!SANITIZE_ALLOWED_TAGS.has(tag)) {
      unwrapElement(element);
      continue;
    }

    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      if (tag === "a" && name === "href") {
        return;
      }
      element.removeAttribute(attribute.name);
    });

    if (tag === "a") {
      const safeHref = getSafeUrl(element.getAttribute("href"));
      if (safeHref) {
        element.setAttribute("href", safeHref);
        element.setAttribute("rel", "noopener noreferrer");
        element.setAttribute("target", "_blank");
      } else {
        element.removeAttribute("href");
      }
    }
  }

  return template.innerHTML;
}

const READER_SANITIZE_ALLOWED_TAGS = new Set([
  "a",
  "article",
  "blockquote",
  "br",
  "code",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "small",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

const READER_SANITIZE_ATTRS = {
  a: new Set(["href"]),
  img: new Set(["src", "alt", "title"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
};

function sanitizeReaderHTML(value, baseUrl) {
  const template = document.createElement("template");
  template.innerHTML = value ?? "";

  const elements = Array.from(template.content.querySelectorAll("*"));
  for (const element of elements) {
    const tag = element.tagName.toLowerCase();
    if (!READER_SANITIZE_ALLOWED_TAGS.has(tag)) {
      unwrapElement(element);
      continue;
    }

    const allowedAttrs = READER_SANITIZE_ATTRS[tag] ?? null;
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        return;
      }
      if (!allowedAttrs || !allowedAttrs.has(name)) {
        element.removeAttribute(attribute.name);
      }
    });

    if (tag === "a") {
      const safeHref = getSafeResolvedUrl(element.getAttribute("href"), baseUrl);
      if (safeHref) {
        element.setAttribute("href", safeHref);
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
      } else {
        element.removeAttribute("href");
      }
      continue;
    }

    if (tag === "img") {
      const safeSrc = getSafeResolvedUrl(element.getAttribute("src"), baseUrl);
      if (!safeSrc) {
        element.remove();
        continue;
      }
      element.setAttribute("src", safeSrc);
      element.setAttribute("loading", "lazy");
      element.setAttribute("decoding", "async");
      element.setAttribute("referrerpolicy", "no-referrer");
    }
  }

  return template.innerHTML.trim();
}

function renderStoryDetail(story) {
  const domain = getDomain(story.url);
  const safeUrl = getSafeUrl(story.url);
  const hnUrl = `https://news.ycombinator.com/item?id=${story.id}`;
  const title = escapeHTML(story.title || "Untitled");
  const storyText = story.text ? sanitizeHNHTML(story.text) : "";

  return `
    <article class="story story-detail">
      <div class="story-title">
        ${safeUrl ? `<a href="${escapeHTML(safeUrl)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title}
        ${domain ? `<span class="domain">(${escapeHTML(domain)})</span>` : ""}
      </div>
      <div class="story-meta">
        <span class="meta-points">${story.score ?? 0} points</span>
        <span class="meta-user">by ${escapeHTML(story.by || "unknown")}</span>
        <span class="meta-time">${timeAgo(story.time)} ago</span>
        <span><a href="${hnUrl}" target="_blank" rel="noopener noreferrer">original thread</a></span>
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

function createCommentLoadingElement(id, depth, message = "loading...") {
  const article = document.createElement("article");
  article.className = "comment comment-loading";
  article.dataset.commentId = String(id);
  applyCommentDepth(article, depth);

  const meta = document.createElement("div");
  meta.className = "comment-meta";
  meta.textContent = message;

  article.appendChild(meta);
  return article;
}

function createCommentFailureElement(id, depth) {
  const article = document.createElement("article");
  article.className = "comment comment-failed";
  article.dataset.commentId = String(id);
  applyCommentDepth(article, depth);

  const meta = document.createElement("div");
  meta.className = "comment-meta";
  meta.textContent = "failed to load";

  const actions = document.createElement("div");
  actions.className = "comment-actions";

  const retryButton = document.createElement("button");
  retryButton.type = "button";
  retryButton.className = "btn";
  retryButton.dataset.action = "retry-comment";
  retryButton.dataset.commentId = String(id);
  retryButton.dataset.depth = String(depth);
  retryButton.textContent = "failed to load - retry";

  actions.appendChild(retryButton);
  article.append(meta, actions);
  return article;
}

function createCommentRenderState({ signal, sectionEl, rootEl, statusEl }) {
  return {
    signal,
    sectionEl,
    rootEl,
    statusEl,
    enqueueFetch: createTaskQueue(MAX_CONCURRENCY, { signal }),
    childLists: new Map(),
    moreItems: new Map(),
    nextListId: 1,
    autoScheduledCount: 0,
    loadedCount: 0,
    failedCount: 0,
  };
}

function updateCommentStatus(state) {
  if (!state.statusEl || !state.statusEl.isConnected) {
    return;
  }

  if (state.loadedCount === 0 && state.failedCount === 0) {
    state.statusEl.textContent = "Loading comments...";
    return;
  }

  const failedSuffix = state.failedCount ? `, ${state.failedCount} failed` : "";
  state.statusEl.textContent = `Loaded ${state.loadedCount} comments${failedSuffix}`;
}

function removeLoadMoreControl(model) {
  if (model.controlEl && model.controlEl.isConnected) {
    model.controlEl.remove();
  }
  model.controlEl = null;
}

function renderLoadMoreControl(state, model, remaining) {
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

function renderCommentResolved(state, slot, item, depth) {
  const normalizedKids = normalizeIds(item?.kids);

  if (item?.type === "more") {
    const article = document.createElement("article");
    article.className = "comment comment-more";
    article.dataset.commentId = String(item.id ?? "");
    applyCommentDepth(article, depth);

    const meta = document.createElement("div");
    meta.className = "comment-meta";
    meta.textContent = `${normalizedKids.length || 0} more replies`;

    const actions = document.createElement("div");
    actions.className = "comment-actions";

    const loadButton = document.createElement("button");
    loadButton.type = "button";
    loadButton.className = "btn";
    loadButton.dataset.action = "load-more-item";
    loadButton.dataset.commentId = String(item.id ?? "");
    loadButton.textContent = "Load more";

    actions.appendChild(loadButton);

    const children = document.createElement("div");
    children.className = "comment-children";

    article.append(meta, actions, children);
    slot.replaceWith(article);

    state.moreItems.set(item.id, {
      id: item.id,
      kids: normalizedKids,
      depth: depth + 1,
      container: children,
      loaded: false,
    });

    state.loadedCount += 1;
    updateCommentStatus(state);
    return;
  }

  const article = document.createElement("article");
  article.className = "comment";
  article.dataset.commentId = String(item?.id ?? "");
  applyCommentDepth(article, depth);

  const meta = document.createElement("div");
  meta.className = "comment-meta";

  const bySpan = document.createElement("span");
  bySpan.className = "meta-user";
  bySpan.textContent = item?.by ? `by ${item.by}` : "by unknown";

  const timeSpan = document.createElement("span");
  timeSpan.className = "meta-time";
  timeSpan.textContent = item?.time ? `${timeAgo(item.time)} ago` : "";

  meta.append(bySpan);
  if (timeSpan.textContent) {
    meta.append(timeSpan);
  }

  const actions = document.createElement("div");
  actions.className = "comment-actions";

  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "btn";
  toggleButton.dataset.action = "toggle-comment";
  toggleButton.textContent = "collapse";

  actions.appendChild(toggleButton);

  const text = document.createElement("div");
  text.className = "comment-text";

  if (item?.deleted) {
    text.textContent = "[deleted]";
  } else if (item?.dead) {
    text.textContent = "[dead]";
  } else if (item?.text) {
    text.innerHTML = sanitizeHNHTML(item.text);
  } else {
    text.textContent = "";
  }

  const children = document.createElement("div");
  children.className = "comment-children";

  article.append(meta, actions, text, children);
  slot.replaceWith(article);

  if (normalizedKids.length) {
    mountChildList(state, children, normalizedKids, depth + 1, { auto: true });
  }

  state.loadedCount += 1;
  updateCommentStatus(state);
}

function fetchAndRenderComment(state, id, slot, depth, { forceRefresh = false } = {}) {
  if (state.signal.aborted || !slot?.isConnected) {
    return;
  }

  state
    .enqueueFetch(() => getItem(id, { signal: state.signal, forceRefresh }))
    .then((item) => {
      if (state.signal.aborted || !slot.isConnected) {
        return;
      }
      if (!item) {
        const failed = createCommentFailureElement(id, depth);
        slot.replaceWith(failed);
        state.failedCount += 1;
        updateCommentStatus(state);
        return;
      }
      renderCommentResolved(state, slot, item, depth);
    })
    .catch((error) => {
      if (isAbortError(error) || state.signal.aborted || !slot.isConnected) {
        return;
      }
      const failed = createCommentFailureElement(id, depth);
      slot.replaceWith(failed);
      state.failedCount += 1;
      updateCommentStatus(state);
    });
}

function loadChildBatch(state, model, { manual = false } = {}) {
  if (state.signal.aborted || !model?.container?.isConnected) {
    return;
  }

  removeLoadMoreControl(model);

  const remaining = model.kidIds.length - model.nextIndex;
  if (remaining <= 0) {
    return;
  }

  let count = Math.min(COMMENTS_BATCH_SIZE, remaining);
  if (model.auto && !manual) {
    const budgetLeft = COMMENTS_AUTO_RENDER_LIMIT - state.autoScheduledCount;
    count = Math.min(count, Math.max(0, budgetLeft));
  }

  if (count <= 0) {
    renderLoadMoreControl(state, model, remaining);
    return;
  }

  const fragment = document.createDocumentFragment();

  for (let offset = 0; offset < count; offset += 1) {
    const kidId = model.kidIds[model.nextIndex + offset];
    const slot = createCommentLoadingElement(kidId, model.depth);
    fragment.appendChild(slot);
    fetchAndRenderComment(state, kidId, slot, model.depth);
  }

  model.nextIndex += count;
  if (model.auto && !manual) {
    state.autoScheduledCount += count;
  }

  model.container.appendChild(fragment);

  const remainingAfter = model.kidIds.length - model.nextIndex;
  if (remainingAfter > 0) {
    renderLoadMoreControl(state, model, remainingAfter);
  }
}

function mountChildList(state, container, kidIds, depth, { auto = true } = {}) {
  const normalizedKids = normalizeIds(kidIds);
  if (!normalizedKids.length || !container?.isConnected) {
    return;
  }

  const listId = `list-${state.nextListId}`;
  state.nextListId += 1;

  const model = {
    id: listId,
    container,
    kidIds: normalizedKids,
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
  state.sectionEl.addEventListener("click", (event) => {
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
      const moreModel = state.moreItems.get(commentId);
      if (!moreModel || moreModel.loaded) {
        return;
      }

      moreModel.loaded = true;
      mountChildList(state, moreModel.container, moreModel.kids, moreModel.depth, {
        auto: false,
      });

      const actionWrap = actionEl.closest(".comment-actions");
      if (actionWrap) {
        actionWrap.remove();
      }
      return;
    }

    if (action === "retry-comment") {
      const current = actionEl.closest(".comment");
      if (!current) {
        return;
      }

      const commentId = Number(
        actionEl.getAttribute("data-comment-id") || current.getAttribute("data-comment-id"),
      );
      const depth = Number(
        actionEl.getAttribute("data-depth") || current.getAttribute("data-depth") || 0,
      );
      if (!Number.isFinite(commentId)) {
        return;
      }

      const loading = createCommentLoadingElement(commentId, depth, "retrying...");
      current.replaceWith(loading);
      fetchAndRenderComment(state, commentId, loading, depth, { forceRefresh: true });
      return;
    }

    if (action === "toggle-comment") {
      const comment = actionEl.closest(".comment");
      if (!comment) {
        return;
      }
      const isCollapsed = comment.classList.toggle("is-collapsed");
      actionEl.textContent = isCollapsed ? "expand" : "collapse";
    }
  });
}

async function renderStoryPage(id) {
  const storyId = Number(id);
  app.dataset.view = "story";
  if (!Number.isFinite(storyId)) {
    app.innerHTML = `
      ${topbar('<a class="btn" href="#/">back</a>')}
      <p class="status">Invalid story id.</p>
    `;
    wireThemeToggleButtons();
    return;
  }

  const controller = new AbortController();
  currentViewController = controller;

  app.innerHTML = `
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
  `;
  wireThemeToggleButtons();

  const detailSlot = app.querySelector(".story-detail");
  const commentsSection = app.querySelector(".comments");
  const commentsRoot = app.querySelector("[data-comments-root]");
  const commentsStatus = app.querySelector("[data-comments-status]");

  if (!detailSlot || !commentsSection || !commentsRoot || !commentsStatus) {
    return;
  }

  let story = null;
  try {
    story = await getItem(storyId, { signal: controller.signal });
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

  if (!story) {
    detailSlot.innerHTML = `
      <div class="story-title">story not found</div>
    `;
    commentsStatus.textContent = "No comments available.";
    return;
  }

  const renderedStory = createElementFromHTML(renderStoryDetail(story));
  if (renderedStory) {
    detailSlot.replaceWith(renderedStory);
  }

  const kidIds = normalizeIds(story.kids);
  if (!kidIds.length) {
    commentsStatus.textContent = "No comments yet.";
    return;
  }

  const commentState = createCommentRenderState({
    signal: controller.signal,
    sectionEl: commentsSection,
    rootEl: commentsRoot,
    statusEl: commentsStatus,
  });

  wireCommentActions(commentState);
  mountChildList(commentState, commentState.rootEl, kidIds, 0, { auto: true });
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-page]");
  if (!target) return;
  event.preventDefault();
});
