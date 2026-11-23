import { COMMENTS_PAGE_SIZE } from "./config.js";
import { fetchThread, startDiscussion } from "./api.js?v=41";
import { createCommentsView } from "./comments.js?v=41";
import { sanitizeHNHTML } from "./sanitize.js?v=41";
import { escapeHTML, getDomain, getSafeUrl, timeAgo, createElementFromHTML, isAbortError } from "./utils.js";

export function createStoryView({ app, ui }) {
  const { topbar } = ui;
  const comments = createCommentsView({ app });
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
      deleted: Boolean(story.deleted),
      dead: Boolean(story.dead),
      score: Number.isFinite(Number(story.score)) ? Number(story.score) : 0,
    };
  }

  function renderStoryDetail(story) {
    const normalized = normalizeStoryDetail(story) || story;
    const domain = getDomain(normalized.url);
    const safeUrl = getSafeUrl(normalized.url);
    const title = escapeHTML(normalized.title || "Untitled");
    const storyText = normalized.deleted ? "[deleted]" : normalized.dead ? "[dead]" : sanitizeHNHTML(normalized.text);
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

  async function renderStoryPage(id, signal, discussion) {
    const storyId = Number(id);
    app.dataset.view = "story";
    teardownStoryKeyboard();

    if (!discussion) {
      app.innerHTML = `
        <section class="list-pane">
          ${topbar('<a class="btn" href="#/">back</a>')}
          <p class="status">Invalid story id.</p>
        </section>
      `;
      return;
    }

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

    let detailSlot = app.querySelector("[data-story-shell]");
    const commentsSection = app.querySelector(".comments");
    const commentsRoot = app.querySelector("[data-comments-root]");
    const commentsStatus = app.querySelector("[data-comments-status]");
    const skeleton = app.querySelector("[data-comment-skeleton]");

    if (!detailSlot || !commentsSection || !commentsRoot || !commentsStatus) {
      return;
    }

    let currentParentPromise;
    function watchStoryDetail(parentPromise) {
      currentParentPromise = parentPromise;
      void parentPromise.then((parent) => {
        if (signal.aborted || parentPromise !== currentParentPromise ||
            !detailSlot?.hasAttribute("data-story-shell")) return;
        if (normalizeStoryDetail(parent)) {
          detailSlot = paintStoryDetail(detailSlot, parent) || detailSlot;
        }
      });
    }

    async function loadComments(threadPromise, parentPromise) {
      let thread;
      try {
        thread = await threadPromise;
      } catch (error) {
        if (isAbortError(error) || signal.aborted) return;

        skeleton?.remove();
        commentsStatus.textContent = "Could not load comments.";
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "btn";
        retry.textContent = "Retry loading comments";
        retry.addEventListener("click", () => {
          commentsStatus.textContent = "Loading comments…";
          if (detailSlot?.hasAttribute("data-story-shell")) {
            const next = startDiscussion(storyId, { signal });
            watchStoryDetail(next.parent);
            void loadComments(next.thread, next.parent);
          } else {
            void loadComments(fetchThread(storyId, { signal }));
          }
        }, { once: true });
        commentsStatus.append(" ", retry);

        if (parentPromise) {
          const parent = await parentPromise;
          if (!signal.aborted && !parent && retry.isConnected && detailSlot?.hasAttribute("data-story-shell")) {
            detailSlot.innerHTML = `
              <div class="story-title">failed to load story</div>
              <div class="story-meta"><span>${escapeHTML(error.message)}</span></div>
            `;
          }
        }
        return;
      }
      if (signal.aborted) return;
      skeleton?.remove();
      renderComments(thread);
    }

    function renderComments(thread) {
      const commentState = createCommentRenderState({
        signal,
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
        if (!signal.aborted) {
          selectCommentIndex(0, { scroll: false });
        }
      });
    }

    watchStoryDetail(discussion.parent);
    await loadComments(discussion.thread, discussion.parent);
  }

  return { renderStoryPage, teardownStoryKeyboard, toggleSelectedComment: comments.toggleSelectedComment };
}
