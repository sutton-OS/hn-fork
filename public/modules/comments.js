import { COMMENTS_PAGE_SIZE, COMMENTS_DOM_BATCH, MAX_COMMENT_DEPTH, COMMENT_CLAMP_PX } from "./config.js";
import { fetchThread } from "./api.js";
import { sanitizeHNHTML } from "./sanitize.js";
import { createTaskQueue, timeAgo, isAbortError, isInteractiveTarget } from "./utils.js";

export function createCommentsView({ app }) {
  let selectedCommentIndex = -1;
  let storyKeyboardHandler = null;
  const commentActionHandlers = new WeakMap();

  function applyCommentDepth(element, depth) {
    const safeDepth = Math.max(0, Number(depth) || 0);
    element.dataset.depth = String(safeDepth);
    element.classList.toggle("is-indented", safeDepth > 0 && safeDepth <= MAX_COMMENT_DEPTH);
  }

  function normalizeThreadComment(node) {
    if (!node || typeof node !== "object") {
      return null;
    }

    const id = Number(node.id);
    if (!Number.isInteger(id) || id <= 0) {
      return null;
    }

    const time = Number(node.time);
    const replyCount = Number(node.replyCount ?? 0);

    return {
      id,
      by: (typeof node.by === "string" && node.by) || "unknown",
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
      rootLoading: false,
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
      items: [],
      seenIds: new Set(),
      serverLoading: false,
      nextIndex: 0,
      depth,
      auto,
      controlEl: null,
      serverParentId,
      serverNextOffset,
      serverTotal,
      serverHasMore,
    };

    appendUniqueComments(model, normalizedComments);
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
    if (!model || model.loaded || model.loading || state.signal.aborted) return;
    model.loading = true;
    model.buttonEl.disabled = true;
    model.buttonEl.textContent = "Loading…";
    try {
      const data = await fetchThread(model.id, {
        signal: state.signal, offset: 0, limit: COMMENTS_PAGE_SIZE,
      });
      if (state.signal.aborted || !model.container?.isConnected) return;
      model.container.replaceChildren();
      mountChildList(state, model.container, data.comments, model.depth, {
        auto: true,
        serverParentId: model.id,
        serverNextOffset: Number(data.nextOffset) || 0,
        serverTotal: Number(data.total) || 0,
        serverHasMore: Boolean(data.hasMore),
      });
      model.loaded = true;
      model.buttonEl.classList.add("is-open");
      model.buttonEl.textContent = model.replyCount === 1 ? "1 reply" : `${model.replyCount} replies`;
      model.buttonEl.setAttribute("aria-expanded", "true");
      model.buttonEl.setAttribute("aria-label", "Collapse replies");
    } catch (error) {
      if (!isAbortError(error) && !state.signal.aborted) {
        model.buttonEl.textContent = "Retry replies";
      }
    } finally {
      model.loading = false;
      model.buttonEl.disabled = false;
    }
  }

  function appendUniqueComments(model, comments) {
    for (const raw of comments) {
      const comment = normalizeThreadComment(raw);
      if (comment && !model.seenIds.has(comment.id)) {
        model.seenIds.add(comment.id);
        model.items.push(comment);
      }
    }
  }

  async function loadMoreServerPage(state, listModel) {
    if (!listModel?.serverParentId || listModel.serverLoading || state.signal.aborted) {
      return;
    }

    listModel.serverLoading = true;
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
      appendUniqueComments(listModel, comments);
      listModel.serverNextOffset = Number.isFinite(Number(data?.nextOffset))
        ? Number(data.nextOffset)
        : listModel.serverNextOffset + comments.length;
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
    } finally {
      listModel.serverLoading = false;
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
    if (isInteractiveTarget(event.target)) {
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
    // Single/double H is handled by handleClassicSkinShortcut (capture phase).
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
        if (model.loaded) {
          const comment = actionEl.closest(".comment");
          const collapsed = comment.classList.toggle("is-collapsed");
          actionEl.setAttribute("aria-expanded", String(!collapsed));
          actionEl.setAttribute("aria-label", collapsed ? "Expand replies" : "Collapse replies");
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
    if (state.signal.aborted || state.rootLoading || !state.rootHasMore) {
      return;
    }

    state.rootLoading = true;
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
      state.rootNextOffset = Number.isFinite(Number(data?.nextOffset))
        ? Number(data.nextOffset)
        : state.rootNextOffset + comments.length;
      state.rootHasMore = Boolean(data?.hasMore);
      state.rootTotal = Number(data?.total) || state.rootTotal;

      const listId = state.rootEl.dataset.listId;
      const listModel = listId ? state.childLists.get(listId) : null;
      if (listModel) {
        appendUniqueComments(listModel, comments);
        // Root pagination is footer-only — keep in-list server controls off.
        listModel.serverNextOffset = state.rootNextOffset;
        listModel.serverHasMore = false;
        listModel.serverTotal = state.rootTotal;
        loadChildBatch(state, listModel, { manual: true });
      } else {
        mountChildList(state, state.rootEl, comments, 0, {
          auto: false,
          serverParentId: parentId,
          serverNextOffset: state.rootNextOffset,
          serverTotal: state.rootTotal,
          serverHasMore: false,
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
    } finally {
      state.rootLoading = false;
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

  return { createCommentRenderState, wireCommentActions, initializeStoryKeyboard, teardownStoryKeyboard, toggleSelectedComment, mountChildList, renderRootMoreFooter, updateCommentStatus, selectCommentIndex };
}
