import { PAGE_SIZE, INITIAL_PAGE_SIZE, FEED_SAVED, LIST_VISIBLE_REFRESH_AFTER_MS } from "./config.js";
import { getStories, getRecentStories, getItem } from "./api.js?v=45";
import { touchInput } from "./pwa.js";
import { navigateTo } from "./routing.js";
import { escapeHTML, getDomain, getSafeUrl, timeAgo, createElementFromHTML, isAbortError, isInteractiveTarget } from "./utils.js";

const LOAD_AHEAD_PX = 160;

export function createFeedView({ app, ui, getCurrentFeed, setViewController, isCurrentView, saved, savedView }) {
  let selectedStoryIndex = -1;
  let showListSelection = false;
  /** Set while keyboard use decides the highlight, so rows scrolling under a still cursor don't change it. */
  let keyboardSelection = false;
  let listKeyboardHandler = null;
  /** The list on screen, and the list kept intact behind an open discussion. */
  let activeList = null;
  let parkedList = null;
  const { topbar, wireFeedToggleButtons } = ui;

  function setSelectedStoryElement(storyEl) {
    if (!storyEl) {
      return;
    }
    const stories = getListStoryElements();
    const nextIndex = stories.indexOf(storyEl);
    if (nextIndex < 0 || (nextIndex === selectedStoryIndex && showListSelection)) {
      return;
    }
    selectedStoryIndex = nextIndex;
    showListSelection = true;
    applyListSelection();
  }

  function hideListSelection() {
    if (!showListSelection) return;
    showListSelection = false;
    applyListSelection();
  }

  // With a mouse, only the story under the cursor is highlighted.
  function handleListPointer(event) {
    if (event.pointerType !== "mouse") return;
    // Some browsers repeat pointermove, without movement, when the page scrolls.
    if (event.type === "pointermove" && (event.movementX || event.movementY)) keyboardSelection = false;
    // Touch screens can report a mouse resting where the last tap was.
    else if (keyboardSelection || touchInput.matches) return;
    const row = event.type === "pointerleave" ? null : event.target.closest?.(".story-list .story");
    if (row) setSelectedStoryElement(row);
    else hideListSelection();
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
      story.classList.toggle("is-selected", showListSelection && index === selectedStoryIndex);
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
    showListSelection = true;
    keyboardSelection = true;
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

  /** A Hacker News ID, which other stories do not have. */
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

    if (getCurrentFeed() === FEED_SAVED || !navigator.onLine) {
      link.click();
      return;
    }

    const href = getSafeUrl(link.getAttribute("href"));
    if (href) {
      link.click();
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
    if (!navigator.onLine) {
      saved.notify("You’re offline. Reconnect to load discussions.");
      return;
    }
    navigateTo(`/item/${storyId}`);
  }

  function handleListKeyboardNavigation(event) {
    if (event.defaultPrevented || savedView.dialog.open || document.body.classList.contains("preview-open")) {
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    if (isInteractiveTarget(event.target)) {
      return;
    }

    const stories = getListStoryElements();
    if (!stories.length) {
      return;
    }

    // Without a highlight, the first press brings it back instead of moving past it.
    const step = showListSelection ? 1 : 0;
    if (event.key === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      selectStoryIndex(selectedStoryIndex + step);
      return;
    }

    if (event.key === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      selectStoryIndex(selectedStoryIndex - step);
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

    if (!showListSelection) return;

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
    showListSelection = false;
    keyboardSelection = false;
    applyListSelection({ scroll: false });

    if (!listEl.dataset.selectionWired) {
      listEl.dataset.selectionWired = "true";

      listEl.addEventListener("focusin", (event) => {
        if (event.target.matches(":focus-visible")) keyboardSelection = true;
        setSelectedStoryElement(event.target.closest(".story"));
      });
    }

    wireListInput();
  }

  function wireListInput() {
    if (!listKeyboardHandler) {
      listKeyboardHandler = handleListKeyboardNavigation;
      document.addEventListener("keydown", listKeyboardHandler);
      document.addEventListener("pointerover", handleListPointer);
      document.addEventListener("pointermove", handleListPointer, { passive: true });
      document.documentElement.addEventListener("pointerleave", handleListPointer);
    }
  }

  /** Detach the list without stopping it, so going back keeps its rows and position. */
  function parkList() {
    const list = activeList;
    if (!list || list.controller.signal.aborted || !isCurrentView(list.controller) || !list.canPark()) return false;
    const focused = list.pane.contains(document.activeElement) ? document.activeElement : null;
    parkedList = {
      list, focused, scrollTop: Math.max(0, window.scrollY), selectedStoryIndex, keyboardSelection,
      // The mouse may be anywhere by the time the list is back.
      showListSelection: showListSelection && (keyboardSelection || touchInput.matches),
    };
    activeList = null;
    teardownListSelection();
    list.pane.remove();
    window.scrollTo({ top: 0, behavior: "instant" });
    return true;
  }

  function resumeList() {
    if (!parkedList) return false;
    const { list, focused, scrollTop, ...selection } = parkedList;
    parkedList = null;
    activeList = list;
    setViewController(list.controller);
    app.dataset.view = "list";
    app.replaceChildren(list.pane);
    // Controls are updated by document queries, which miss a detached list.
    const count = list.pane.querySelector("[data-saved-count]");
    if (count) count.textContent = saved.count();
    list.pane.querySelector("[data-theme-toggle]")
      ?.setAttribute("aria-pressed", String(document.documentElement.dataset.theme === "light"));
    focused?.focus({ preventScroll: true });
    ({ selectedStoryIndex, showListSelection, keyboardSelection } = selection);
    applyListSelection();
    wireListInput();
    window.scrollTo({ top: scrollTop, behavior: "instant" });
    list.resume();
    return true;
  }

  /** Look for new stories without rebuilding the list. Returns false if it has nothing to keep. */
  function refreshList() {
    if (!activeList?.canPark() || !activeList.refresh) return false;
    activeList.refresh();
    return true;
  }

  /** Details already on screen for a story, used while its discussion loads. */
  function findStory(id) {
    return (activeList || parkedList?.list)?.lookup(id) || null;
  }

  function teardownListSelection() {
    selectedStoryIndex = -1;

    if (listKeyboardHandler) {
      document.removeEventListener("keydown", listKeyboardHandler);
      document.removeEventListener("pointerover", handleListPointer);
      document.removeEventListener("pointermove", handleListPointer);
      document.documentElement.removeEventListener("pointerleave", handleListPointer);
      listKeyboardHandler = null;
    }
  }

  function createLoadingRow(index, message = "loading...") {
    const row = document.createElement("li");
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
      <li class="story" data-story-rank="${index}">
        <div class="story-title"><span class="story-title-text">failed to load</span></div>
        <div class="story-meta">
          <span>item ${id}</span>
          <span><button class="btn" type="button" data-retry-id="${id}" data-retry-rank="${index}">retry</button></span>
        </div>
      </li>
    `;
  }

  function wireStoryActions(listEl, lookup) {
    listEl.addEventListener("click", (event) => {
      const row = event.target.closest(".story[data-story-id]");
      if (!row) return;
      const id = Number(row.dataset.storyId);
      const bookmark = event.target.closest("[data-bookmark]");
      const title = event.target.closest(".story-title a");
      if (bookmark) {
        const story = lookup(id);
        if (story) void saved.ready.then(() => savedView.toggle(story));
      } else if (event.target.closest("[data-remove-saved]")) {
        saved.remove(id);
      } else if (event.target.closest("[data-retry-saved]")) {
        saved.retry(id);
      } else if (title && (getCurrentFeed() === FEED_SAVED || (!navigator.onLine && saved.get(id)))) {
        event.preventDefault();
        savedView.open(id, title);
      }
    });
    listEl.addEventListener("error", (event) => {
      if (event.target.matches(".story-favicon")) event.target.hidden = true;
    }, true);
  }

  function renderSavedPage(controller) {
    app.dataset.view = "list";
    app.innerHTML = `
      <section class="list-pane">
        ${topbar()}
        <div id="feed-panel" role="tabpanel" aria-labelledby="feed-tab-saved">
          <p class="status saved-empty">Nothing saved yet. Tap the bookmark on any story.</p>
          <ul class="story-list" role="list"></ul>
          <footer class="saved-footer">
            <p class="status" data-saved-size></p>
            <button class="btn" type="button" data-clear-saved>Clear all saved</button>
          </footer>
        </div>
      </section>
    `;
    wireFeedToggleButtons();
    const listEl = app.querySelector(".story-list");
    const empty = app.querySelector(".saved-empty");
    const size = app.querySelector("[data-saved-size]");
    const clear = app.querySelector("[data-clear-saved]");
    const rows = new Map();
    let estimateVersion = 0;

    function paint() {
      const version = ++estimateVersion;
      const items = saved.list();
      const present = new Set(items.map((item) => item.id));
      let lostFocus = false;
      for (const [id, row] of rows) {
        if (!present.has(id)) {
          lostFocus ||= row.contains(document.activeElement);
          row.remove();
          rows.delete(id);
        }
      }

      let next = listEl.firstElementChild;
      for (const [index, item] of items.entries()) {
        let row = rows.get(item.id);
        if (!row) {
          row = createElementFromHTML(renderStoryRow(item, index + 1, { savedRow: true }));
          rows.set(item.id, row);
        }
        row.dataset.storyRank = index + 1;
        if (row !== next) listEl.insertBefore(row, next);
        next = row.nextElementSibling;
        savedView.updateRow(row);
      }

      empty.hidden = items.length > 0;
      clear.disabled = items.length === 0;
      size.textContent = `${items.length} saved`;
      if (lostFocus || (!items.length && document.activeElement === clear)) {
        (listEl.querySelector(".story-title a") || app.querySelector("#feed-tab-saved"))?.focus({ preventScroll: true });
      }
      applyListSelection();
      void saved.estimate().then((storage) => {
        if (version === estimateVersion && !controller.signal.aborted && Number.isFinite(storage?.usage)) {
          size.textContent = `${items.length} saved, ~${(storage.usage / 1_000_000).toFixed(1)} MB`;
        }
      });
    }

    activeList = {
      controller, pane: app.firstElementChild, lookup: saved.get, canPark: () => true, resume: paint,
    };
    clear.addEventListener("click", () => saved.clear());
    wireStoryActions(listEl, saved.get);
    initializeListSelection(listEl);
    saved.events.addEventListener("change", paint, { signal: controller.signal });
    window.addEventListener("online", paint, { signal: controller.signal });
    window.addEventListener("offline", paint, { signal: controller.signal });
    paint();
  }

  async function renderListPage({ scrollTop = 0, fresh = false } = {}) {
    const controller = new AbortController();
    setViewController(controller);
    if (getCurrentFeed() === FEED_SAVED) {
      renderSavedPage(controller);
      return;
    }
    const feedName = getCurrentFeed();
    const storiesById = new Map();
    let infiniteObserver = null;
    let scrollHandler = null;
    const teardownInfiniteLoading = () => {
      if (infiniteObserver) {
        infiniteObserver.disconnect();
        infiniteObserver = null;
      }
      if (scrollHandler) {
        window.removeEventListener("scroll", scrollHandler);
        scrollHandler = null;
      }
    };

    controller.signal.addEventListener("abort", teardownInfiniteLoading, { once: true });

    try {
      app.dataset.view = "list";
      app.innerHTML = `
        <section class="list-pane">
          ${topbar()}
          <div id="feed-panel" role="tabpanel" aria-labelledby="feed-tab-${getCurrentFeed()}" aria-busy="true">
            <div class="pull-indicator" aria-hidden="true"></div>
            <div class="feed-update"><button class="btn" type="button" data-feed-update hidden></button></div>
            <ul class="story-list" role="list"></ul>
            <p class="status" data-list-status hidden></p>
            <button class="btn" type="button" data-list-retry hidden>Retry loading stories</button>
            <div data-list-sentinel aria-hidden="true"></div>
          </div>
        </section>
      `;
      wireFeedToggleButtons();

      const panel = app.querySelector("#feed-panel");
      const updateButton = app.querySelector("[data-feed-update]");
      const listEl = app.querySelector(".story-list");
      const listStatus = app.querySelector("[data-list-status]");
      const retryPageButton = app.querySelector("[data-list-retry]");
      const sentinel = app.querySelector("[data-list-sentinel]");
      if (!listEl || !listStatus || !sentinel) {
        return;
      }

      let restoreTop = scrollTop;
      panel.toggleAttribute("data-restoring-scroll", restoreTop > 0);
      const finishRestoringScroll = () => {
        restoreTop = 0;
        panel.removeAttribute("data-restoring-scroll");
      };

      initializeListSelection(listEl);
      wireStoryActions(listEl, (id) => storiesById.get(id));
      function refreshRowActions(event) {
        const id = event?.detail;
        if (id) {
          const row = listEl.querySelector(`[data-story-id="${id}"].story`);
          if (row) savedView.updateRow(row);
        } else {
          listEl.querySelectorAll(".story[data-story-id]").forEach(savedView.updateRow);
        }
      }
      saved.events.addEventListener("change", refreshRowActions, { signal: controller.signal });

      const setListStatus = (value = "") => {
        const next = (value || "").trim();
        listStatus.hidden = !next;
        listStatus.textContent = next;
      };

      const replaceRow = (sourceRow, html) => {
        // A parked list is detached, so check the list instead of the document.
        if (sourceRow?.parentNode !== listEl) {
          return;
        }
        const next = createElementFromHTML(html);
        if (!next) {
          return;
        }
        savedView.updateRow(next);
        sourceRow.replaceWith(next);
        applyListSelection({ scroll: false });
      };

      listEl.addEventListener("click", async (event) => {
        setSelectedStoryElement(event.target.closest(".story"));
        const retryButton = event.target.closest("[data-retry-id]");
        if (!retryButton) {
          return;
        }
        event.preventDefault();

        if (controller.signal.aborted || !isCurrentView(controller)) {
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

        if (controller.signal.aborted) {
          return;
        }

        if (story) {
          storiesById.set(Number(story.id), story);
          replaceRow(loadingRow, renderStoryRow(story, rank));
          return;
        }

        replaceRow(loadingRow, renderFailedStoryRow(id, rank));
      });

      let isLoadingBatch = false;
      let hasMore = true;
      let nextBatchStart = 0;
      let hasLoadedPage = false;
      let hasScrolled = false;
      let stoppedOffline = false;
      const seenStoryIds = new Set();
      let generation = 0;
      let checkedAt = 0;
      let checking = false;
      let engaged = false;
      let pendingPage = null;

      // Rows must not move under a reader who has started using them.
      const markEngaged = () => { engaged = true; };
      listEl.addEventListener("pointerdown", markEngaged, { passive: true });
      listEl.addEventListener("pointermove", markEngaged, { passive: true });
      listEl.addEventListener("focusin", markEngaged);

      const overlayOpen = () => document.body.classList.contains("preview-open") || savedView.dialog.open;

      const setPendingPage = (page, count = 0) => {
        pendingPage = page;
        updateButton.hidden = !page;
        if (page) updateButton.textContent = count === 1 ? "1 new story" : `${count} new stories`;
      };

      const createRow = (story, rank) => {
        const valid = story && Number.isFinite(Number(story.id));
        if (valid && Number.isSafeInteger(Number(story.id))) storiesById.set(Number(story.id), story);
        const row = createElementFromHTML(valid ? renderStoryRow(story, rank) : renderFailedStoryRow("unknown", rank));
        if (row) savedView.updateRow(row);
        return row;
      };

      const pageStories = (page) => {
        const ids = new Set();
        return (Array.isArray(page?.stories) ? page.stories : []).filter((story) => {
          const id = Number(story?.id);
          if (!Number.isSafeInteger(id) || ids.has(id)) return false;
          ids.add(id);
          return true;
        });
      };

      const startsWith = (stories) => stories.every((story, index) =>
        Number(listEl.children[index]?.dataset.storyId) === Number(story.id));

      // Swap in a newer first page, reusing unchanged rows so focus and icons stay put.
      const applyFirstPage = (page) => {
        const stories = pageStories(page);
        if (!stories.length) return;
        const selectedId = selectedStoryIndex > 0 ? Number(listEl.children[selectedStoryIndex]?.dataset.storyId) : null;
        const keepRest = startsWith(stories);
        const oldRows = new Map(Array.from(listEl.children, (row) => [Number(row.dataset.storyId), row]));
        const rows = stories.map((story, index) => {
          const id = Number(story.id);
          const old = oldRows.get(id);
          const previous = storiesById.get(id);
          if (!old || previous?.title !== story.title || previous?.url !== story.url) return createRow(story, index + 1);
          storiesById.set(id, story);
          old.dataset.storyRank = String(index + 1);
          const age = old.querySelector("[data-story-age]");
          if (age) age.textContent = storyAge(story);
          return old;
        });
        if (keepRest) rows.push(...Array.from(listEl.children).slice(stories.length));

        const wanted = new Set(rows);
        for (const row of Array.from(listEl.children)) if (!wanted.has(row)) row.remove();
        let next = listEl.firstElementChild;
        for (const row of rows) {
          if (row === next) next = next.nextElementSibling;
          else listEl.insertBefore(row, next);
        }

        if (!keepRest) {
          generation += 1;
          seenStoryIds.clear();
          for (const story of stories) seenStoryIds.add(Number(story.id));
          nextBatchStart = page.nextOffset;
          hasMore = Boolean(page.hasMore);
          hasScrolled = false;
          retryPageButton.hidden = true;
          setListStatus("");
          if (hasMore) wireInfiniteLoading();
        }
        if (selectedId) {
          const index = rows.findIndex((row) => Number(row.dataset.storyId) === selectedId);
          if (index >= 0) selectedStoryIndex = index;
        }
        applyListSelection();
        requestNextBatchIfNeeded();
      };

      const receiveFirstPage = (page) => {
        if (controller.signal.aborted || !isCurrentView(controller)) return;
        const stories = pageStories(page);
        if (!stories.length) return;
        checkedAt = Date.now();
        const open = overlayOpen();
        if (!open && (startsWith(stories) || (!engaged && !restoreTop && window.scrollY <= 0))) {
          applyFirstPage(page);
          setPendingPage(null);
          return;
        }
        const count = stories.filter((story) => !seenStoryIds.has(Number(story.id))).length;
        setPendingPage(count ? page : null, count);
      };

      const refresh = async () => {
        if (checking || !navigator.onLine) return;
        checking = true;
        engaged = false;
        try {
          receiveFirstPage(await getStories(feedName, {
            signal: controller.signal, offset: 0, limit: INITIAL_PAGE_SIZE,
          }));
        } catch {
          // The stories on screen are still usable. The next return tries again.
        } finally {
          checking = false;
        }
      };

      updateButton.addEventListener("click", () => {
        const page = pendingPage;
        setPendingPage(null);
        if (!page) return;
        applyFirstPage(page);
        engaged = false;
        finishRestoringScroll();
        window.scrollTo({ top: 0, behavior: "instant" });
        if (!touchInput.matches) listEl.querySelector(".story-title a")?.focus({ preventScroll: true });
      });

      activeList = {
        controller,
        pane: app.firstElementChild,
        lookup: (id) => storiesById.get(id),
        canPark: () => hasLoadedPage,
        refresh,
        resume() {
          finishRestoringScroll();
          refreshRowActions();
          requestNextBatchIfNeeded();
          if (Date.now() - checkedAt >= LIST_VISIBLE_REFRESH_AFTER_MS) void refresh();
        },
      };

      const handleBackgroundLoadError = (error) => {
        if (
          isAbortError(error) ||
          controller.signal.aborted ||
          !isCurrentView(controller)
        ) {
          return;
        }
        hasMore = false;
        stoppedOffline = !navigator.onLine;
        setListStatus(stoppedOffline
          ? hasLoadedPage ? "Reconnect to load more stories." : "Reconnect to load this feed for offline use."
          : `Could not load stories: ${error.message}`);
        retryPageButton.hidden = stoppedOffline;
      };

      const loadNextBatchInBackground = () => {
        void loadNextBatch().catch(handleBackgroundLoadError);
      };

      retryPageButton.addEventListener("click", () => {
        hasMore = true;
        loadNextBatchInBackground();
      });

      const shouldLoadMoreNow = () => {
        if (restoreTop || !hasLoadedPage || !sentinel.isConnected || document.body.classList.contains("preview-open")) {
          return false;
        }
        const canScroll = document.documentElement.scrollHeight > window.innerHeight + 1;
        if (canScroll && !hasScrolled && seenStoryIds.size) return false;
        const rect = sentinel.getBoundingClientRect();
        return rect.top <= window.innerHeight + LOAD_AHEAD_PX;
      };

      const requestNextBatchIfNeeded = () => {
        if (
          hasMore &&
          !isLoadingBatch &&
          !controller.signal.aborted &&
          isCurrentView(controller) &&
          shouldLoadMoreNow()
        ) {
          window.setTimeout(() => {
            loadNextBatchInBackground();
          }, 0);
        }
      };

      window.addEventListener("offline", () => {
        refreshRowActions();
        if (!retryPageButton.hidden) {
          stoppedOffline = true;
          retryPageButton.hidden = true;
          setListStatus("Reconnect to load stories.");
        }
      }, { signal: controller.signal });
      window.addEventListener("online", () => {
        refreshRowActions();
        if (stoppedOffline) {
          stoppedOffline = false;
          hasMore = true;
          loadNextBatchInBackground();
        }
      }, { signal: controller.signal });

      const loadNextBatch = async () => {
        if (
          isLoadingBatch ||
          controller.signal.aborted ||
          !isCurrentView(controller) ||
          !hasMore
        ) {
          return;
        }

        isLoadingBatch = true;
        retryPageButton.hidden = true;
        setListStatus("Loading stories...");

        try {
          const batchStart = nextBatchStart;
          const batchLimit = batchStart === 0 ? INITIAL_PAGE_SIZE : PAGE_SIZE;
          const batchGeneration = generation;
          const request = getStories(feedName, {
            signal: controller.signal,
            offset: batchStart,
            limit: batchLimit,
            fresh: fresh && batchStart === 0,
          });
          let page = null;
          if (batchStart === 0 && !fresh && navigator.onLine) {
            // Show the last stored page now. The live page follows below.
            request.catch(() => {});
            page = await getRecentStories(feedName, { limit: batchLimit });
            if (page && !pageStories(page).length) page = null;
            if (page) request.then(receiveFirstPage, () => {});
          }
          if (!page) {
            page = await request;
            if (batchStart === 0) checkedAt = Date.now();
          }
          if (controller.signal.aborted || !isCurrentView(controller) || batchGeneration !== generation) {
            return;
          }

          const fetchedStories = Array.isArray(page.stories) ? page.stories : [];
          hasLoadedPage = true;
          nextBatchStart = Number.isFinite(page.nextOffset)
            ? page.nextOffset
            : batchStart + batchLimit;
          hasMore = Boolean(page.hasMore);

          if (!fetchedStories.length && !hasMore) {
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

          // Empty filtered page but more IDs remain — keep scrolling.
          if (!batchStories.length) {
            if (!hasMore) {
              teardownInfiniteLoading();
            }
            setListStatus("");
            return;
          }

          const fragment = document.createDocumentFragment();
          const nextRows = [];
          let visibleRank = listEl.querySelectorAll(".story").length;
          batchStories.forEach((story) => {
            visibleRank += 1;
            const row = createRow(story, visibleRank);
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

          if (controller.signal.aborted || !isCurrentView(controller)) {
            return;
          }

          if (!hasMore) {
            teardownInfiniteLoading();
          }

          setListStatus("");
        } finally {
          isLoadingBatch = false;
          requestNextBatchIfNeeded();
        }
      };

      function wireInfiniteLoading() {
        if (scrollHandler) return;
        if ("IntersectionObserver" in window) infiniteObserver = new IntersectionObserver(
          (entries) => {
            const shouldLoad = entries.some((entry) => entry.isIntersecting);
            if (shouldLoad) {
              requestNextBatchIfNeeded();
            }
          },
          { rootMargin: `${LOAD_AHEAD_PX}px 0px` },
        );
        infiniteObserver?.observe(sentinel);
        scrollHandler = () => {
          // A parked list must ignore scrolling in the discussion above it.
          if (!isCurrentView(controller) || (infiniteObserver && hasScrolled)) return;
          if (window.scrollY <= 0) return;
          finishRestoringScroll();
          hasScrolled = true;
          requestNextBatchIfNeeded();
        };
        window.addEventListener("scroll", scrollHandler, { passive: true });
      }
      wireInfiniteLoading();

      await loadNextBatch().catch(handleBackgroundLoadError);
      panel.removeAttribute("aria-busy");

      // A saved position can be below the first page. Use the normal pager to
      // reach it, yielding to the user if they start scrolling while it loads.
      const scrollRoot = document.scrollingElement;
      while (restoreTop && hasMore && isCurrentView(controller) &&
        scrollRoot.scrollHeight - scrollRoot.clientHeight < restoreTop &&
        !document.body.classList.contains("preview-open")) {
        const previousOffset = nextBatchStart;
        await loadNextBatch().catch(handleBackgroundLoadError);
        if (nextBatchStart <= previousOffset) break;
      }
      if (restoreTop && isCurrentView(controller)) {
        if (!document.body.classList.contains("preview-open")) {
          window.scrollTo({ top: restoreTop, behavior: "instant" });
        }
        finishRestoringScroll();
        requestNextBatchIfNeeded();
      }
    } catch (error) {
      teardownInfiniteLoading();
      if (
        isAbortError(error) ||
        controller.signal.aborted ||
        !isCurrentView(controller)
      ) {
        return;
      }
      app.innerHTML = `
        <section class="list-pane">
          ${topbar()}
          <div id="feed-panel" role="tabpanel" aria-labelledby="feed-tab-${getCurrentFeed()}">
            <p class="status">Could not load stories: ${escapeHTML(error.message)}</p>
          </div>
        </section>
      `;
      wireFeedToggleButtons();
    }
  }

  function storyAge(story) {
    return `${timeAgo(story.hnTime ?? story.time)} ago`;
  }

  function renderStoryRow(story, index, { savedRow = false } = {}) {
    if (!story) {
      return "";
    }

    const storyId = Number(story.id);
    const domain = (story.domain || getDomain(story.url) || "news.ycombinator.com").toLowerCase();
    const safeUrl = getSafeUrl(story.url);
    const discussionPath = Number.isInteger(storyId) && storyId > 0 ? `#/item/${storyId}` : "#/";
    const storyUrl = savedRow ? "#reader-title" : safeUrl || discussionPath;
    const storyTitleRaw = story.title || "Untitled";
    const storyTitle = escapeHTML(storyTitleRaw);
    const escapedStoryUrl = escapeHTML(storyUrl);
    const isExternal = !savedRow && Boolean(safeUrl);
    // Stories from outside Hacker News have a section instead of a discussion, and no item to preview or save.
    const section = savedRow ? "" : story.section || "";
    const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
    const age = storyAge(story);
    const titleContent = `
      <a
        href="${escapedStoryUrl}"
        ${isExternal ? 'target="_blank" rel="noopener noreferrer"' : ""}
        ${savedRow ? 'aria-haspopup="dialog"' : "data-online-link"}
        ${section ? 'data-preview-bypass="true"' : ""}
        data-story-id="${storyId}"
      >${storyTitle}</a>
    `;

    return `
      <li class="story" data-story-rank="${index}" data-story-id="${storyId}">
        <div class="story-title">${titleContent}</div>
        <div class="story-meta story-bookmark-meta">
          <div class="story-meta-content">
            <span class="story-source">
              ${savedRow || !navigator.onLine ? "" : `<span class="favicon-slot" aria-hidden="true">
                <img class="story-favicon" src="${escapeHTML(faviconUrl)}" width="16" height="16"
                  alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
              </span>`}
              <span class="domain">${escapeHTML(domain)}</span>
            </span>
            <span class="meta-part"><span class="meta-divider" aria-hidden="true">·</span> <span data-story-age>${age}</span></span>
            <span class="meta-part">
              <span class="meta-divider" aria-hidden="true">·</span>
              ${section ? `<span>${escapeHTML(section)}</span>`
                : `<a class="story-comments-link" href="${escapeHTML(discussionPath)}" data-online-link aria-label="comments on ${storyTitle}">comments</a>`}
            </span>
          </div>
          ${section ? "" : `<div class="story-save-actions">
            ${savedView.bookmark(storyId)}
            ${savedRow ? savedView.overflow(storyTitleRaw) : ""}
          </div>`}
        </div>
        ${section ? "" : savedView.rowStatus()}
      </li>
    `;
  }

  return { renderListPage, teardownListSelection, parkList, resumeList, refreshList, findStory };
}
