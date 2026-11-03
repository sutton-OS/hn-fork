import { FEED_BEST, LIST_VISIBLE_REFRESH_AFTER_MS } from "./modules/config.js";
import { normalizeFeed, isInteractiveTarget } from "./modules/utils.js";
import { parseRoute } from "./modules/routing.js";
import { createUI } from "./modules/ui.js";
import { createFeedView } from "./modules/feed.js";
import { createCommentsView } from "./modules/comments.js";
import { createStoryView } from "./modules/story.js";

const app = document.getElementById("app");
app.classList.add("shell");
let currentViewController = null;
let currentFeed = FEED_BEST;
let listHiddenAt = 0;
const DOUBLE_H_MS = 320;
let hTapTimer = null;
let hTapPending = false;

const getCurrentFeed = () => currentFeed;
const setViewController = (controller) => { currentViewController = controller; };
const isCurrentView = (controller) => currentViewController === controller;
const ui = createUI({ app, getCurrentFeed, setFeed: applyFeed });
const feed = createFeedView({ app, ui, getCurrentFeed, setViewController, isCurrentView });
const comments = createCommentsView({ app });
const story = createStoryView({ app, ui, comments, setViewController, isCurrentView });

function classicSkinUrl() {
  const route = parseRoute();
  if (route.type === "story" && route.id) {
    return `/classic/item/${route.id}`;
  }
  const feed = normalizeFeed(currentFeed);
  return feed === FEED_BEST ? "/classic" : `/classic/${feed}`;
}

function handleClassicSkinShortcut(event) {
  if (event.defaultPrevented) {
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
      comments.toggleSelectedComment();
    }
  }, DOUBLE_H_MS);
}

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
  feed.teardownListSelection();
  app.dataset.view = "";
  app.innerHTML = "";

  if (route.type === "story") {
    await story.renderStoryPage(route.id);
    return;
  }

  await feed.renderListPage();
}

function canHandleRouteInPlace(route) {
  return app.dataset.view === "list" && route.type === "list";
}

function applyFeed(feed) {
  currentFeed = normalizeFeed(feed);
  rerenderListForFeedChange();
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

function abortCurrentViewLoad() {
  if (currentViewController) {
    currentViewController.abort();
    currentViewController = null;
  }
  comments.teardownStoryKeyboard();
}

ui.applyTheme(ui.readStoredTheme());
window.addEventListener("hashchange", handleRouteChange);
window.addEventListener("pageshow", handlePageShow);
document.addEventListener("visibilitychange", handleVisibilityChange);
document.addEventListener("keydown", handleClassicSkinShortcut, true);
void handleRouteChange();

// One-time cleanup for older installs that registered a service worker.
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((reg) => {
      void reg.unregister();
    });
  });
}
