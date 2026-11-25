import { FEED_BEST, FEED_SAVED, LIST_VISIBLE_REFRESH_AFTER_MS } from "./modules/config.js";
import { normalizeFeed, isInteractiveTarget } from "./modules/utils.js";
import { wireNotificationStories, wirePreview } from "./modules/preview-entry.js";
import { wireAlerts } from "./modules/alerts.js";
import { touchInput, wirePWA } from "./modules/pwa.js";
import { parseRoute } from "./modules/routing.js";
import { normalizeTab } from "./modules/feed-cache.js?v=46";
import { createUI } from "./modules/ui.js?v=46";
import { createFeedView } from "./modules/feed.js?v=46";
import { startDiscussion, wireDiscussionPrefetch } from "./modules/api.js?v=46";

import { createSavedStories } from "./modules/saved.js";
import { createSavedView } from "./modules/saved-view.js";

const app = document.getElementById("app");
const banner = document.querySelector("[data-offline-banner]");
app.classList.add("shell");
wirePreview(app);
let currentViewController = null;
let story = null;
let storyModule = null;
let currentFeed = FEED_BEST;
const feedScrollPositions = new Map();
let listHiddenAt = 0;
const DOUBLE_H_MS = 320;
let hTapTimer = null;
let hTapPending = false;

const getCurrentFeed = () => currentFeed;
const setViewController = (controller) => { currentViewController = controller; };
const isCurrentView = (controller) => currentViewController === controller;
const saved = createSavedStories();
const savedView = createSavedView(saved);
const ui = createUI({ app, getCurrentFeed, setFeed: applyFeed, saved });
const feed = createFeedView({ app, ui, getCurrentFeed, setViewController, isCurrentView, saved, savedView });

function updateConnectivity() {
  banner.hidden = navigator.onLine;
}

function guardOnlineAction(event) {
  const link = event.target.closest?.("a[data-online-link]");
  if (event.defaultPrevented || navigator.onLine || !link) return;
  event.preventDefault();
  saved.notify("You’re offline. Reconnect to open this link.");
}

saved.events.addEventListener("change", () => {
  const count = app.querySelector("[data-saved-count]");
  if (count) count.textContent = saved.count();
});

function classicSkinUrl() {
  const route = parseRoute();
  if (route.type === "story" && route.id) {
    return `/classic/item/${route.id}`;
  }
  const feed = normalizeFeed(currentFeed);
  return feed === FEED_BEST ? "/classic" : `/classic/${feed}`;
}

function handleClassicSkinShortcut(event) {
  if (document.body.classList.contains("preview-open")) return;
  if (event.defaultPrevented || savedView.dialog.open) {
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }
  if (event.key !== "h" && event.key !== "H") {
    return;
  }
  if (isInteractiveTarget(event.target)) {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();

  if (hTapPending) {
    hTapPending = false;
    if (hTapTimer) {
      clearTimeout(hTapTimer);
      hTapTimer = null;
    }
    window.location.href = classicSkinUrl();
    return;
  }

  hTapPending = true;
  hTapTimer = setTimeout(() => {
    hTapPending = false;
    hTapTimer = null;
    // Single H: collapse/expand selected comment in story view only.
    if (app.dataset.view === "story") {
      story?.toggleSelectedComment();
    }
  }, DOUBLE_H_MS);
}

function handlePageShow(event) {
  if (event.persisted) {
    refreshQuietly();
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
    refreshQuietly();
  }
  listHiddenAt = 0;
}

function canRefreshList() {
  return !document.body.classList.contains("preview-open") && app.dataset.view === "list" &&
    currentFeed !== FEED_SAVED && navigator.onLine && !savedView.dialog.open;
}

// Coming back to the page must not lose the reader's place.
function refreshQuietly() {
  if (canRefreshList() && !feed.refreshList()) refreshCurrentList();
}

function refreshCurrentList() {
  if (!canRefreshList()) return;
  void renderRoute({ type: "list" }, { fresh: true });
}

function loadStoryModule() {
  storyModule ??= import("./modules/story.js?v=46").catch((error) => {
    storyModule = null;
    throw error;
  });
  return storyModule;
}

async function handleRouteChange() {
  const route = parseRoute();

  if (canHandleRouteInPlace(route)) {
    return;
  }

  await renderRoute(route);
}

async function renderRoute(route = parseRoute(), { scrollTop, fresh = false } = {}) {
  const known = route.type === "story" ? feed.findStory(route.id) : null;
  if (route.type === "story") {
    // Applies to this history entry. Going forward must not scroll the list before it is parked.
    history.scrollRestoration = "manual";
    if (app.dataset.view === "list" && feed.parkList()) currentViewController = null;
  }
  abortCurrentViewLoad();
  if (route.type === "list" && feed.resumeList()) return;
  feed.teardownListSelection();
  app.dataset.view = "";
  app.innerHTML = "";

  if (route.type === "story") {
    if (!navigator.onLine) {
      app.dataset.view = "story";
      app.innerHTML = `
        <section class="list-pane">
          ${ui.topbar('<a class="btn" href="#/">back</a>')}
          <p class="status">Reconnect to load this discussion.</p>
        </section>
      `;
      return;
    }
    const controller = new AbortController();
    setViewController(controller);
    const validId = Number.isInteger(route.id) && route.id > 0 && route.id <= 999999999999;
    const discussion = validId ? startDiscussion(route.id, { signal: controller.signal }) : null;

    try {
      const { createStoryView } = await loadStoryModule();
      if (!isCurrentView(controller)) return;
      story ??= createStoryView({ app, ui });
      await story.renderStoryPage(route.id, controller.signal, discussion, known);
    } catch {
      if (!isCurrentView(controller) || controller.signal.aborted) return;
      controller.abort();
      app.innerHTML = `
        <section class="list-pane">
          ${ui.topbar('<a class="btn" href="#/">back</a>')}
          <p class="status">Could not load the discussion.</p>
          <button class="btn" type="button" data-story-retry>Retry loading discussion</button>
        </section>
      `;
      app.querySelector("[data-story-retry]").addEventListener("click", () => {
        void renderRoute(route);
      }, { once: true });
    }
    return;
  }

  if (scrollTop !== undefined) window.scrollTo({ top: 0, behavior: "instant" });
  await feed.renderListPage({ scrollTop, fresh });
}

function canHandleRouteInPlace(route) {
  return app.dataset.view === "list" && route.type === "list";
}

function applyFeed(feed) {
  const nextFeed = normalizeTab(feed);
  let scrollTop;
  if (touchInput.matches && nextFeed !== currentFeed && app.dataset.view === "list") {
    const panel = app.querySelector("#feed-panel");
    if (!panel?.hasAttribute("data-restoring-scroll")) {
      feedScrollPositions.set(currentFeed, Math.max(0, window.scrollY));
    }
    scrollTop = feedScrollPositions.get(nextFeed) ?? 0;
  }
  currentFeed = nextFeed;
  rerenderListForFeedChange(scrollTop);
}

function rerenderListForFeedChange(scrollTop) {
  if (app.dataset.view !== "list") {
    return;
  }
  const hash = window.location.hash.replace(/^#/, "").trim();
  if (hash && hash !== "/") {
    window.location.hash = "/";
  }
  void renderRoute({ type: "list" }, { scrollTop });
}

function abortCurrentViewLoad() {
  if (currentViewController) {
    currentViewController.abort();
    currentViewController = null;
  }
  story?.teardownStoryKeyboard();
}

window.addEventListener("hashchange", handleRouteChange);
window.addEventListener("pageshow", handlePageShow);
document.addEventListener("visibilitychange", handleVisibilityChange);
document.addEventListener("keydown", handleClassicSkinShortcut, true);
document.addEventListener("click", guardOnlineAction);
document.addEventListener("auxclick", guardOnlineAction);
window.addEventListener("online", updateConnectivity);
window.addEventListener("offline", updateConnectivity);
updateConnectivity();
wireDiscussionPrefetch(app, () => void loadStoryModule().catch(() => {}));
wirePWA(app, refreshCurrentList);
wireAlerts(app);
wireNotificationStories(app);
void handleRouteChange();
