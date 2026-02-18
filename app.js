const STORIES_ENDPOINT = "/api/stories";
const ITEM_ENDPOINT = "/api/item";
const HN_FALLBACK_BASE = "https://hacker-news.firebaseio.com/v0";
const PAGE_SIZE = 30;
const FALLBACK_FETCH_CONCURRENCY = 8;
const THEME_STORAGE_KEY = "hn-fork:theme:v1";
const FEED_STORAGE_KEY = "hn-fork:feed:v1";
const COMMENTS_BATCH_SIZE = 30;
const COMMENTS_AUTO_RENDER_LIMIT = 200;
const PREVIEW_HASH_PREFIX = "p=";
const PREVIEW_BLOCK_TIMEOUT_MS = 2500;
const PREVIEW_EMBED_BLOCKED_MESSAGE =
  "This site may block embedding. Use Open in new tab.";
const READER_ENDPOINT = "/api/reader";
const THREAD_ENDPOINT = "/api/thread";
const READABILITY_MODULE_URL = "https://esm.sh/@mozilla/readability@0.5.0?bundle";
const THEME_TERMINAL = "terminal";
const THEME_DARK = "dark";
const THEME_LIGHT = "light";
const THEMES = [THEME_TERMINAL, THEME_DARK, THEME_LIGHT];
const FEED_BEST = "best";
const FEED_TOP = "top";
const FEED_NEW = "new";
const FEEDS = [FEED_BEST, FEED_TOP, FEED_NEW];
const app = document.getElementById("app");
app?.classList.add("shell");

const unescape = document.createElement("textarea");
let currentViewController = null;
let selectedStoryIndex = -1;
let listKeyboardHandler = null;
let currentTheme = THEME_TERMINAL;
let currentFeed = FEED_BEST;
const previewState = {
  activeUrl: "",
  loadToken: 0,
  blockedTimer: null,
  readerController: null,
  mode: "embed",
};
let readabilityModulePromise = null;

applyTheme(loadSavedTheme());
applyFeed(loadSavedFeed());
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
  app.dataset.view = "";
  app.innerHTML = "";

  if (route.type === "story") {
    await renderStoryPage(route.id);
    return;
  }

  await renderListPage();
  applyListRoute(route);
}

function canHandleRouteInPlace(route) {
  return app.dataset.view === "list" && route.type === "list";
}

function applyListRoute(route) {
  if (route.type !== "list") {
    return;
  }
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

function normalizeTheme(theme) {
  if (theme === "bloomberg") {
    return THEME_DARK;
  }
  if (theme === "bloomberg-light") {
    return THEME_LIGHT;
  }
  return THEMES.includes(theme) ? theme : THEME_TERMINAL;
}

function normalizeFeed(feed) {
  return FEEDS.includes(feed) ? feed : FEED_BEST;
}

function loadSavedTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return normalizeTheme(saved);
  } catch {
    return THEME_TERMINAL;
  }
}

function loadSavedFeed() {
  try {
    const saved = localStorage.getItem(FEED_STORAGE_KEY);
    return normalizeFeed(saved);
  } catch {
    return FEED_BEST;
  }
}

function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, normalizeTheme(theme));
  } catch {}
}

function saveFeed(feed) {
  try {
    localStorage.setItem(FEED_STORAGE_KEY, normalizeFeed(feed));
  } catch {}
}

function getThemeLabel(theme = currentTheme) {
  if (theme === THEME_DARK) {
    return "icons/theme-moon.svg";
  }
  if (theme === THEME_LIGHT) {
    return "icons/theme-sun.svg";
  }
  return "icons/theme-keyboard.svg";
}

function getThemeName(theme = currentTheme) {
  if (theme === THEME_DARK) {
    return "Dark";
  }
  if (theme === THEME_LIGHT) {
    return "Light";
  }
  return "Terminal";
}

function getThemeButtonContent(theme = currentTheme) {
  return `<img class="theme-toggle-icon" src="${getThemeLabel(theme)}" alt="" aria-hidden="true" />`;
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

function getFeedIcon(feed = currentFeed) {
  const normalized = normalizeFeed(feed);
  if (normalized === FEED_TOP) {
    return "icons/feed-flame.svg";
  }
  if (normalized === FEED_NEW) {
    return "icons/feed-activity.svg";
  }
  return "icons/feed-trophy.svg";
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
      <img class="feed-option-icon" src="${getFeedIcon(normalized)}" alt="" aria-hidden="true" />
      <span class="feed-option-label">${getFeedLabel(normalized)}</span>
    </button>
  `;
}

function updateThemeToggleLabels() {
  const name = getThemeName();
  const content = getThemeButtonContent();
  app.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    button.innerHTML = content;
    button.setAttribute("aria-label", `Theme: ${name}`);
  });
}

function updateFeedToggleLabels() {
  const normalized = normalizeFeed(currentFeed);
  const feedIndex = Math.max(0, FEEDS.indexOf(normalized));
  app.querySelectorAll("[data-feed-picker]").forEach((picker) => {
    picker.style.setProperty("--feed-index", String(feedIndex));
    picker.querySelectorAll("[data-feed-option]").forEach((button) => {
      const optionFeed = normalizeFeed(button.getAttribute("data-feed-option"));
      const isActive = optionFeed === normalized;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
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

function applyFeed(feed, { persist = false, rerender = false } = {}) {
  const normalized = normalizeFeed(feed);
  const didChange = normalized !== currentFeed;
  currentFeed = normalized;
  if (persist) {
    saveFeed(currentFeed);
  }
  updateFeedToggleLabels();
  if (rerender && didChange) {
    rerenderListForFeedChange();
  }
}

function toggleTheme() {
  const currentIndex = THEMES.indexOf(currentTheme);
  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % THEMES.length : 0;
  const next = THEMES[nextIndex];
  applyTheme(next, { persist: true });
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

function wireFeedToggleButtons(root = app) {
  root.querySelectorAll("[data-feed-option]").forEach((button) => {
    if (button.dataset.feedWired) {
      return;
    }
    button.dataset.feedWired = "true";
    button.addEventListener("click", () => {
      const next = button.getAttribute("data-feed-option");
      applyFeed(next, { persist: true, rerender: true });
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

async function fetchJSON(url, { signal, errorPrefix = "Request failed" } = {}) {
  const response = await fetch(url, { signal });
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
    const preview = body.slice(0, 200);
    throw new Error(
      `${errorPrefix}: non-JSON response (${contentType || "unknown"}): ${preview}`,
    );
  }

  return response.json();
}

function isNotFoundError(error) {
  return /\b404\b/.test(String(error?.message || ""));
}

async function fetchHNJSON(path, { signal, errorPrefix = "HN request failed" } = {}) {
  const response = await fetch(`${HN_FALLBACK_BASE}/${path}`, { signal });
  if (!response.ok) {
    throw new Error(`${errorPrefix}: ${response.status}`);
  }
  return response.json();
}

async function fetchInChunks(items, limit, worker, { signal } = {}) {
  const results = [];
  for (let index = 0; index < items.length; index += limit) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    const chunk = items.slice(index, index + limit);
    const batch = await Promise.all(chunk.map(worker));
    results.push(...batch);
  }
  return results;
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

async function getStories(feed, { signal, offset = 0, limit = PAGE_SIZE } = {}) {
  const normalizedFeed = normalizeFeed(feed);
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.max(1, Number(limit) || PAGE_SIZE);

  try {
    const params = new URLSearchParams({
      feed: normalizedFeed,
      offset: String(safeOffset),
      limit: String(safeLimit),
    });
    const payload = await fetchJSON(
      `${STORIES_ENDPOINT}?${params.toString()}`,
      {
        signal,
        errorPrefix: "Stories request failed",
      },
    );
    return Array.isArray(payload) ? payload : [];
  } catch (error) {
    if (isAbortError(error) || !isNotFoundError(error)) {
      throw error;
    }
  }

  const ids = await fetchHNJSON(`${normalizedFeed}stories.json`, {
    signal,
    errorPrefix: "Stories fallback failed",
  });
  const pageIds = (Array.isArray(ids) ? ids : [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(safeOffset, safeOffset + safeLimit);

  const stories = await fetchInChunks(
    pageIds,
    FALLBACK_FETCH_CONCURRENCY,
    (id) =>
      fetchHNJSON(`item/${id}.json`, {
        signal,
        errorPrefix: "Story fallback item failed",
      }).catch(() => null),
    { signal },
  );

  return stories.filter((story) => story && Number.isFinite(Number(story.id)));
}

async function getItem(id, { signal, forceRefresh = false } = {}) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return null;
  }

  void forceRefresh;
  try {
    return await fetchJSON(`${ITEM_ENDPOINT}?id=${numericId}`, {
      signal,
      errorPrefix: "Item request failed",
    });
  } catch (error) {
    if (isAbortError(error) || !isNotFoundError(error)) {
      throw error;
    }
  }

  const fallbackItem = await fetchHNJSON(`item/${numericId}.json`, {
    signal,
    errorPrefix: "Item fallback failed",
  });
  return fallbackItem || null;
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
        <div class="feed-picker" role="group" aria-label="Story feed" data-feed-picker>
          <span class="feed-picker-slider" aria-hidden="true"></span>
          ${FEEDS.map((feed) => getFeedPickerButton(feed)).join("")}
        </div>
        <button
          class="btn theme-toggle"
          type="button"
          data-theme-toggle
          aria-label="Theme: ${getThemeName()}"
        >
          ${getThemeButtonContent()}
        </button>
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
    <div class="story-title"><span class="story-rank">${index}.</span><span class="story-title-text">${message}</span></div>
    <div class="story-meta"><span>fetching story details...</span></div>
  `;
  return row;
}

function appendLoadingRows(listEl, count, startIndex) {
  const slots = [];
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < count; i += 1) {
    const row = createLoadingRow(startIndex + i + 1);
    slots.push(row);
    fragment.appendChild(row);
  }

  listEl.appendChild(fragment);
  return slots;
}

function renderFailedStoryRow(id, index) {
  return `
    <article class="story" data-story-rank="${index}">
      <div class="story-title"><span class="story-rank">${index}.</span><span class="story-title-text">failed to load</span></div>
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
    wireThemeToggleButtons();
    wireFeedToggleButtons();

    const listEl = app.querySelector(".story-list");
    const listStatus = app.querySelector("[data-list-status]");
    const sentinel = app.querySelector("[data-list-sentinel]");
    if (!listEl || !listStatus || !sentinel) {
      return;
    }

    initializeListSelection(listEl);
    applyListRoute(parseRoute());

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
      applyListRoute(parseRoute());
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
        replaceRow(loadingRow, renderStoryRow(story, rank));
        return;
      }

      replaceRow(loadingRow, renderFailedStoryRow(id, rank));
    });

    let isLoadingBatch = false;
    let hasMore = true;
    let nextBatchStart = 0;
    const seenStoryIds = new Set();

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
        const fetchedStories = await getStories(currentFeed, {
          signal: controller.signal,
          offset: batchStart,
          limit: PAGE_SIZE,
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

        const slots = appendLoadingRows(listEl, batchStories.length, batchStart);
        if (selectedStoryIndex < 0 && slots.length) {
          selectedStoryIndex = 0;
        }
        applyListSelection({ scroll: false });

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

        batchStories.forEach((story, index) => {
          if (controller.signal.aborted || currentViewController !== controller) {
            return;
          }
          const rank = batchStart + index + 1;
          if (story && Number.isFinite(Number(story.id))) {
            replaceSlot(index, renderStoryRow(story, rank));
            return;
          }
          replaceSlot(index, renderFailedStoryRow("unknown", rank));
        });

        if (controller.signal.aborted || currentViewController !== controller) {
          return;
        }

        if (fetchedStories.length < PAGE_SIZE) {
          hasMore = false;
          teardownInfiniteLoading();
        }

        setListStatus("");
      } finally {
        isLoadingBatch = false;
      }
    };

    if ("IntersectionObserver" in window) {
      infiniteObserver = new IntersectionObserver(
        (entries) => {
          const shouldLoad = entries.some((entry) => entry.isIntersecting);
          if (shouldLoad) {
            void loadNextBatch();
          }
        },
        { rootMargin: "600px 0px" },
      );
      infiniteObserver.observe(sentinel);
    } else {
      scrollFallbackHandler = () => {
        if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 600) {
          void loadNextBatch();
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
      ${topbar("")}
      <p class="status">Could not load stories: ${escapeHTML(error.message)}</p>
    `;
    wireThemeToggleButtons();
    wireFeedToggleButtons();
  }
}

function renderStoryRow(story, index) {
  if (!story) {
    return "";
  }

  const domain = getDomain(story.url);
  const safeUrl = getSafeUrl(story.url);
  const storyUrl = safeUrl || `https://news.ycombinator.com/item?id=${story.id}`;
  const commentsCount = story.descendants ?? 0;
  const localCommentsUrl = `#/item/${story.id}`;
  const storyTitleRaw = story.title || "Untitled";
  const storyTitle = escapeHTML(storyTitleRaw);
  const escapedStoryUrl = escapeHTML(storyUrl);
  const titleContent = `
    <a
      href="${escapedStoryUrl}"
      target="_blank"
      rel="noopener noreferrer"
      data-story-id="${story.id}"
    ><span class="story-rank">${index}.</span><span class="story-title-text">${storyTitle}</span></a>
  `;

  return `
    <article class="story" data-story-rank="${index}">
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

  const bySpan = document.createElement("span");
  bySpan.className = "meta-user";
  bySpan.textContent = item.by ? `by ${item.by}` : "by unknown";

  const timeSpan = document.createElement("span");
  timeSpan.className = "meta-time";
  timeSpan.textContent = item.time ? `${timeAgo(item.time)} ago` : "";

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
  toggleButton.dataset.slot = "toggle";
  toggleButton.textContent = "-";
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
    text.textContent = "[deleted]";
  }

  const children = document.createElement("div");
  children.className = "comment-children";

  const normalizedKids = Array.isArray(item.children)
    ? item.children.filter((child) => child && Number.isFinite(child.id))
    : [];

  if (normalizedKids.length) {
    const repliesButton = document.createElement("button");
    repliesButton.type = "button";
    repliesButton.className = "btn";
    repliesButton.dataset.action = "load-replies";
    repliesButton.dataset.slot = "replies";
    repliesButton.dataset.commentId = String(item.id);
    repliesButton.textContent = String(normalizedKids.length);
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
      actionEl.remove();
      return;
    }

    if (action === "toggle-comment") {
      const comment = actionEl.closest(".comment");
      if (!comment) {
        return;
      }
      const isCollapsed = comment.classList.toggle("is-collapsed");
      actionEl.textContent = isCollapsed ? "+" : "-";
      const nextLabel = isCollapsed ? "Expand comment" : "Collapse comment";
      actionEl.setAttribute("aria-label", nextLabel);
      actionEl.title = nextLabel;
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
    wireFeedToggleButtons();
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
  wireFeedToggleButtons();

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

  const commentState = createCommentRenderState({
    signal: controller.signal,
    sectionEl: commentsSection,
    rootEl: commentsRoot,
    statusEl: commentsStatus,
  });

  wireCommentActions(commentState);

  let thread = null;
  try {
    thread = await fetchThread(story.id || storyId, { signal: controller.signal });
  } catch (error) {
    if (
      isAbortError(error) ||
      controller.signal.aborted ||
      currentViewController !== controller
    ) {
      return;
    }

    commentsStatus.textContent = "Could not load comments.";
    return;
  }

  if (controller.signal.aborted || currentViewController !== controller) {
    return;
  }

  const threadComments = normalizeThreadChildren(thread);
  if (!threadComments.length) {
    commentsStatus.textContent = "No comments yet.";
    return;
  }

  mountChildList(commentState, commentState.rootEl, threadComments, 0, { auto: true });
}
