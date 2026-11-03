import { COMMENTS_PAGE_SIZE } from "./config.js";
import { getItem, fetchThread, wireDiscussionPrefetch } from "./api.js";
import { sanitizeHNHTML } from "./sanitize.js";
import { escapeHTML, getDomain, getSafeUrl, timeAgo, createElementFromHTML, isAbortError } from "./utils.js";

export function createStoryView({ app, ui, comments, setViewController, isCurrentView }) {
  const { topbar, wireThemeToggle, wireFeedToggleButtons } = ui;
  const { createCommentRenderState, wireCommentActions, initializeStoryKeyboard, teardownStoryKeyboard, mountChildList, renderRootMoreFooter, updateCommentStatus, selectCommentIndex } = comments;

  function normalizeStoryDetail(story) {
    if (!story || typeof story !== "object") {
      return null;
    }

    const id = Number(story.id);
    if (!Number.isInteger(id) || id <= 0) {
      return null;
    }

    const time = Number(story.time);
    const url = typeof story.url === "string" ? story.url : "";
    const by = typeof story.by === "string" ? story.by : "";

    return {
      id,
      title: typeof story.title === "string" ? story.title : "",
      url,
      by,
      time: Number.isFinite(time) ? time : 0,
      text: typeof story.text === "string" ? story.text : "",
      score: Number.isFinite(Number(story.score)) ? Number(story.score) : 0,
    };
  }

  function renderStoryDetail(story) {
    const normalized = normalizeStoryDetail(story) || story;
    const domain = getDomain(normalized.url);
    const safeUrl = getSafeUrl(normalized.url);
    const title = escapeHTML(normalized.title || "Untitled");
    const storyText = normalized.text ? sanitizeHNHTML(normalized.text) : "";
    const byline = normalized.by ? escapeHTML(normalized.by) : "";

    const urlLabel = safeUrl || "";
    return `
      <article class="story story-detail">
        <div class="story-title">
          ${safeUrl ? `<a href="${escapeHTML(safeUrl)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title}
        </div>
        ${
          urlLabel
            ? `<a class="story-url" href="${escapeHTML(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHTML(urlLabel)}</a>`
            : domain
              ? `<span class="story-url">${escapeHTML(domain)}</span>`
              : ""
        }
        <div class="story-meta">
          ${byline ? `<span class="meta-user">${byline}</span>` : ""}
          <span class="meta-time">${timeAgo(normalized.time)} ago</span>
        </div>
        ${storyText ? `<div class="story-text">${storyText}</div>` : ""}
      </article>
    `;
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
    setViewController(controller);

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
        !isCurrentView(controller) ||
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
        !isCurrentView(controller)
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
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn";
      retry.textContent = "Retry loading comments";
      retry.addEventListener("click", () => {
        controller.abort();
        void renderStoryPage(storyId);
      }, { once: true });
      commentsStatus.append(" ", retry);
      return;
    }

    if (controller.signal.aborted || !isCurrentView(controller)) {
      return;
    }

    if (thread && normalizeStoryDetail(thread)) {
      if (detailSlot?.isConnected && detailSlot.hasAttribute("data-story-shell")) {
        detailSlot = paintStoryDetail(detailSlot, thread) || detailSlot;
      }
    } else if (detailSlot?.hasAttribute?.("data-story-shell")) {
      const item = await itemPromise;
      if (controller.signal.aborted || !isCurrentView(controller)) {
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
    commentState.rootNextOffset = Number.isFinite(Number(thread?.nextOffset))
      ? Number(thread.nextOffset)
      : (Number(thread?.offset) || 0) + rootComments.length;
    commentState.rootTotal = Number(thread?.total) || rootComments.length;
    commentState.rootHasMore = Boolean(thread?.hasMore);

    wireCommentActions(commentState);
    initializeStoryKeyboard();

    if (!rootComments.length && !commentState.rootHasMore) {
      commentsStatus.textContent = "No comments yet.";
      return;
    }

    // Footer owns root "load more" — avoid a second in-list control.
    mountChildList(commentState, commentState.rootEl, rootComments, 0, {
      auto: true,
      serverParentId: storyId,
      serverNextOffset: commentState.rootNextOffset,
      serverTotal: commentState.rootTotal,
      serverHasMore: false,
    });
    renderRootMoreFooter(commentState, storyId);
    updateCommentStatus(commentState);

    window.requestAnimationFrame(() => {
      if (!controller.signal.aborted) {
        selectCommentIndex(0, { scroll: false });
      }
    });
  }

  return { renderStoryPage };
}
