const {
  getQueryString,
  parseItemId,
  parsePositiveInt,
  parseNonNegativeInt,
  fetchCommentPage,
  extractDomain,
  UPSTREAM,
} = require("../../lib/hn");
const {
  normalizeTheme,
  plainFeedPath,
  plainItemPath,
  renderThemeLinks,
  renderLayout,
  sendHTML,
  renderComment,
  escapeHTML,
  getSafeUrl,
  sanitizeHNHTML,
  timeAgo,
} = require("../../lib/html");

const UA = "hnx-html-item/1.0";

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    sendHTML(
      res,
      405,
      renderLayout({
        title: "Method not allowed — HNx",
        theme: "dark",
        body: `<section class="list-pane"><p class="status">Method not allowed.</p></section>`,
      }),
    );
    return;
  }

  const theme = normalizeTheme(getQueryString(req.query?.theme));
  const itemId = parseItemId(req.query?.id);
  const offset = parseNonNegativeInt(getQueryString(req.query?.offset), 0);
  const limit = Math.min(
    parsePositiveInt(getQueryString(req.query?.limit), UPSTREAM.threadDefaultLimit),
    UPSTREAM.threadMaxLimit,
  );

  if (!itemId) {
    sendHTML(
      res,
      400,
      renderLayout({
        title: "Invalid item — HNx",
        theme,
        body: `
          <section class="list-pane">
            <p class="status">Invalid item id.</p>
            <p><a class="btn" href="${escapeHTML(plainFeedPath("best", theme))}">Back to feed</a></p>
          </section>
        `,
      }),
    );
    return;
  }

  const currentPath =
    offset > 0
      ? `/plain/item/${itemId}?offset=${offset}`
      : `/plain/item/${itemId}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM.timeoutMs);

  try {
    const payload = await fetchCommentPage(itemId, {
      offset,
      limit,
      signal: controller.signal,
      userAgent: UA,
    });

    if (!payload) {
      sendHTML(
        res,
        404,
        renderLayout({
          title: "Not found — HNx",
          theme,
          body: `
            <section class="list-pane">
              <p class="status">Item not found.</p>
              <p><a class="btn" href="${escapeHTML(plainFeedPath("best", theme))}">Back to feed</a></p>
            </section>
          `,
        }),
      );
      return;
    }

    const isComment = payload.type === "comment";
    const titleText =
      payload.title || (isComment ? `Comment ${itemId}` : "Untitled");
    const safeUrl = getSafeUrl(payload.url);
    const domain = extractDomain(payload.url) || "";
    const backHref = escapeHTML(plainFeedPath("best", theme));
    const parentHref =
      Number.isInteger(payload.parent) && payload.parent > 0
        ? escapeHTML(plainItemPath(payload.parent, theme))
        : "";

    const titleHtml = safeUrl
      ? `<a href="${escapeHTML(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHTML(titleText)}</a>`
      : escapeHTML(titleText);

    const urlLine = safeUrl
      ? `<a class="story-url" href="${escapeHTML(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHTML(safeUrl)}</a>`
      : domain
        ? `<span class="story-url">${escapeHTML(domain)}</span>`
        : "";

    const opText = payload.text
      ? `<div class="story-text">${sanitizeHNHTML(payload.text)}</div>`
      : "";

    const comments = Array.isArray(payload.comments) ? payload.comments : [];
    const commentsHtml = comments.length
      ? comments.map((c) => renderComment(c, theme)).join("")
      : offset === 0
        ? `<p class="status">No comments yet.</p>`
        : `<p class="status">No more comments.</p>`;

    const moreHtml = payload.hasMore
      ? `<p class="plain-more"><a class="btn" href="${escapeHTML(
          plainItemPath(itemId, theme, { offset: payload.nextOffset }),
        )}">Load more comments (${Math.max(0, payload.total - payload.nextOffset)})</a></p>`
      : "";

    const body = `
      <section class="list-pane">
        <header class="topbar">
          <div class="topbar-start">
            <a class="btn" href="${backHref}">back</a>
            ${parentHref ? `<a class="btn" href="${parentHref}">parent</a>` : ""}
          </div>
          <div class="topbar-actions">
            ${renderThemeLinks(theme, currentPath)}
          </div>
        </header>
        <p class="plain-banner status">
          Plain HTML mode (no JavaScript).
          <a href="/#/item/${itemId}">Full app</a>
        </p>
        <article class="story story-detail">
          <div class="story-title">${titleHtml}</div>
          ${urlLine}
          <div class="story-meta">
            ${payload.by ? `<span class="meta-user">${escapeHTML(payload.by)}</span>` : ""}
            ${payload.time ? `<span class="meta-time">${escapeHTML(timeAgo(payload.time))} ago</span>` : ""}
          </div>
          ${opText}
        </article>
        <section class="comments">
          <h2 class="comments-title">Comments</h2>
          <div class="comment-children">
            ${commentsHtml}
          </div>
          ${moreHtml}
        </section>
      </section>
    `;

    sendHTML(
      res,
      200,
      renderLayout({
        title: `${titleText} — HNx`,
        theme,
        body,
        description: `Discussion: ${titleText}`,
      }),
    );
  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? "Request timed out."
        : error?.message || "Failed to load item.";
    sendHTML(
      res,
      error?.name === "AbortError" ? 504 : 502,
      renderLayout({
        title: "Error — HNx",
        theme,
        body: `
          <section class="list-pane">
            <header class="topbar">
              <div class="topbar-start">
                <a class="btn" href="${escapeHTML(plainFeedPath("best", theme))}">back</a>
              </div>
            </header>
            <p class="status">${escapeHTML(message)}</p>
          </section>
        `,
      }),
    );
  } finally {
    clearTimeout(timer);
  }
};
