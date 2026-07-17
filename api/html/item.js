const {
  HN_BASE_URL,
  getQueryString,
  parsePositiveInt,
  parseNonNegativeInt,
  fetchJSON,
  mapWithConcurrency,
  extractDomain,
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

const TIMEOUT_MS = 12000;
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 80;
const MAX_CONCURRENCY = 28;
const UA = "hnx-html-item/1.0";

function leanComment(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  const kids = Array.isArray(raw.kids)
    ? raw.kids.map((k) => Number(k)).filter((k) => Number.isInteger(k) && k > 0)
    : [];
  const time = Number(raw.time);
  return {
    id,
    by: typeof raw.by === "string" ? raw.by : "",
    time: Number.isFinite(time) ? time : 0,
    text: typeof raw.text === "string" ? raw.text : "",
    replyCount: kids.length,
    deleted: Boolean(raw.deleted),
    dead: Boolean(raw.dead),
  };
}

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
  const rawId = getQueryString(req.query?.id);
  const itemId = Number(rawId);
  const offset = parseNonNegativeInt(getQueryString(req.query?.offset), 0);
  const limit = Math.min(
    parsePositiveInt(getQueryString(req.query?.limit), DEFAULT_LIMIT),
    MAX_LIMIT,
  );

  if (!rawId || !Number.isInteger(itemId) || itemId <= 0) {
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
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const parentRaw = await fetchJSON(`${HN_BASE_URL}/item/${itemId}.json`, {
      signal: controller.signal,
      userAgent: UA,
    });

    if (!parentRaw || typeof parentRaw !== "object") {
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

    const kidIds = Array.isArray(parentRaw.kids)
      ? parentRaw.kids
          .map((k) => Number(k))
          .filter((k) => Number.isInteger(k) && k > 0)
      : [];
    const pageIds = kidIds.slice(offset, offset + limit);

    const childRaw = pageIds.length
      ? await mapWithConcurrency(pageIds, MAX_CONCURRENCY, (id) =>
          fetchJSON(`${HN_BASE_URL}/item/${id}.json`, {
            signal: controller.signal,
            userAgent: UA,
          }).catch(() => null),
        )
      : [];
    const comments = childRaw.map((item) => leanComment(item)).filter(Boolean);
    const nextOffset = offset + pageIds.length;
    const hasMore = nextOffset < kidIds.length;

    const isComment = parentRaw.type === "comment";
    const titleText =
      (typeof parentRaw.title === "string" && parentRaw.title) ||
      (isComment ? `Comment ${itemId}` : "Untitled");
    const url = typeof parentRaw.url === "string" ? parentRaw.url : "";
    const safeUrl = getSafeUrl(url);
    const domain = extractDomain(url) || "";
    const by = typeof parentRaw.by === "string" ? parentRaw.by : "";
    const time = Number(parentRaw.time) || 0;
    const text = typeof parentRaw.text === "string" ? parentRaw.text : "";
    const parentId = Number(parentRaw.parent);

    const backHref = escapeHTML(plainFeedPath("best", theme));
    const parentHref =
      Number.isInteger(parentId) && parentId > 0
        ? escapeHTML(plainItemPath(parentId, theme))
        : "";

    const titleHtml = safeUrl
      ? `<a href="${escapeHTML(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHTML(titleText)}</a>`
      : escapeHTML(titleText);

    const urlLine = safeUrl
      ? `<a class="story-url" href="${escapeHTML(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHTML(safeUrl)}</a>`
      : domain
        ? `<span class="story-url">${escapeHTML(domain)}</span>`
        : "";

    const opText = text
      ? `<div class="story-text">${sanitizeHNHTML(text)}</div>`
      : "";

    const commentsHtml = comments.length
      ? comments.map((c) => renderComment(c, theme)).join("")
      : offset === 0
        ? `<p class="status">No comments yet.</p>`
        : `<p class="status">No more comments.</p>`;

    const moreHtml = hasMore
      ? `<p class="plain-more"><a class="btn" href="${escapeHTML(
          plainItemPath(itemId, theme, { offset: nextOffset }),
        )}">Load more comments (${kidIds.length - nextOffset})</a></p>`
      : "";

    const body = `
      <section class="list-pane">
        <header class="topbar">
          <div class="topbar-start">
            <a class="btn" href="${backHref}">back</a>
            ${
              parentHref
                ? `<a class="btn" href="${parentHref}">parent</a>`
                : ""
            }
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
            ${by ? `<span class="meta-user">${escapeHTML(by)}</span>` : ""}
            ${time ? `<span class="meta-time">${escapeHTML(timeAgo(time))} ago</span>` : ""}
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
