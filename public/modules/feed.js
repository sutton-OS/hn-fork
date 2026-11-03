import { PAGE_SIZE, INITIAL_PAGE_SIZE } from "./config.js";
import { getStories, getItem, wireDiscussionPrefetch } from "./api.js";
import { navigateTo } from "./routing.js";
import { escapeHTML, getDomain, getSafeUrl, timeAgo, createElementFromHTML, isAbortError, isInteractiveTarget } from "./utils.js";

export function createFeedView({ app, ui, getCurrentFeed, setViewController, isCurrentView }) {
  let selectedStoryIndex = -1;
  let listKeyboardHandler = null;
  const { topbar, wireThemeToggle, wireFeedToggleButtons } = ui;

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

    if (isInteractiveTarget(event.target)) {
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
    setViewController(controller);
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
          <button class="btn" type="button" data-list-retry hidden>Retry loading stories</button>
          <div data-list-sentinel aria-hidden="true"></div>
        </section>
      `;
      wireThemeToggle();
      wireFeedToggleButtons();
      wireDiscussionPrefetch(app);

      const listEl = app.querySelector(".story-list");
      const listStatus = app.querySelector("[data-list-status]");
      const retryPageButton = app.querySelector("[data-list-retry]");
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

        if (controller.signal.aborted || !isCurrentView(controller)) {
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
          !isCurrentView(controller)
        ) {
          return;
        }
        hasMore = false;
        setListStatus(`Could not load stories: ${error.message}`);
        retryPageButton.hidden = false;
      };

      const loadNextBatchInBackground = () => {
        void loadNextBatch().catch(handleBackgroundLoadError);
      };

      retryPageButton.addEventListener("click", () => {
        hasMore = true;
        loadNextBatchInBackground();
      });

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
          isCurrentView(controller) &&
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
          const page = await getStories(getCurrentFeed(), {
            signal: controller.signal,
            offset: batchStart,
            limit: batchLimit,
          });
          if (controller.signal.aborted || !isCurrentView(controller)) {
            return;
          }

          const fetchedStories = Array.isArray(page.stories) ? page.stories : [];
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
            const html =
              story && Number.isFinite(Number(story.id))
                ? renderStoryRow(story, visibleRank)
                : renderFailedStoryRow("unknown", visibleRank);
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

      await loadNextBatch().catch(handleBackgroundLoadError);
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

  return { renderListPage, teardownListSelection };
}
