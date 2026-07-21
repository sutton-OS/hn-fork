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
  normalizeSkin,
  plainFeedPath,
  plainItemPath,
  classicFeedPath,
  classicItemPath,
  renderThemeLinks,
  renderLayout,
  renderClassicLayout,
  renderClassicNav,
  classicCommentItem,
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

  const skin = normalizeSkin(getQueryString(req.query?.skin));
  const isClassic = skin === "classic";
  const theme = normalizeTheme(getQueryString(req.query?.theme));
  const itemId = parseItemId(req.query?.id);
  const offset = parseNonNegativeInt(getQueryString(req.query?.offset), 0);
  const limit = Math.min(
    parsePositiveInt(getQueryString(req.query?.limit), UPSTREAM.threadDefaultLimit),
    UPSTREAM.threadMaxLimit,
  );

  if (!itemId) {
    if (isClassic) {
      sendHTML(
        res,
        400,
        renderClassicLayout({
          title: "Invalid item — HNx",
          body: `
${renderClassicNav("best")}
<p>Invalid item id.</p>
<p><a href="${escapeHTML(classicFeedPath("best"))}">Back to feed</a></p>
`,
        }),
      );
      return;
    }
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

  const currentPath = isClassic
    ? offset > 0
      ? `/classic/item/${itemId}?offset=${offset}`
      : `/classic/item/${itemId}`
    : offset > 0
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
      if (isClassic) {
        sendHTML(
          res,
          404,
          renderClassicLayout({
            title: "Not found — HNx",
            body: `
${renderClassicNav("best")}
<p>Item not found.</p>
<p><a href="${escapeHTML(classicFeedPath("best"))}">Back to feed</a></p>
`,
          }),
        );
        return;
      }
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

    const comments = Array.isArray(payload.comments) ? payload.comments : [];

    if (isClassic) {
      const backHref = escapeHTML(classicFeedPath("best"));
      const parentHref =
        Number.isInteger(payload.parent) && payload.parent > 0
          ? escapeHTML(classicItemPath(payload.parent))
          : "";
      const titleHtml = safeUrl
        ? `<a href="${escapeHTML(safeUrl)}">${escapeHTML(titleText)}</a>`
        : escapeHTML(titleText);
      const urlLine = safeUrl
        ? `<br><a href="${escapeHTML(safeUrl)}">${escapeHTML(safeUrl)}</a>`
        : domain
          ? `<br>${escapeHTML(domain)}`
          : "";
      const opText = payload.text
        ? `<div class="op">${sanitizeHNHTML(payload.text)}</div>`
        : "";
      const metaBits = [
        payload.by ? `by ${escapeHTML(payload.by)}` : "",
        payload.time ? `${escapeHTML(timeAgo(payload.time))} ago` : "",
      ]
        .filter(Boolean)
        .join(" · ");

      const commentsHtml = comments.length
        ? comments.map((c) => classicCommentItem(c)).join("\n")
        : offset === 0
          ? `<p>No comments yet.</p>`
          : `<p>No more comments.</p>`;

      const moreHtml = payload.hasMore
        ? `<p><a href="${escapeHTML(
            classicItemPath(itemId, { offset: payload.nextOffset }),
          )}">More comments (${Math.max(0, payload.total - payload.nextOffset)})...</a></p>`
        : "";

      const body = `
${renderClassicNav("best")}
<p>
  <a href="${backHref}">back</a>${parentHref ? ` | <a href="${parentHref}">parent</a>` : ""}
  | <a href="/#/item/${itemId}">modern UI</a>
</p>
<hr>
<h1>${titleHtml}</h1>
${urlLine}
${metaBits ? `<p><small>${metaBits}</small></p>` : ""}
${opText}
<hr>
<p><b>Comments</b></p>
${commentsHtml}
${moreHtml}
<hr>
<p><small>Classic HTML mode (no JavaScript).</small></p>
`;

      sendHTML(
        res,
        200,
        renderClassicLayout({
          title: `${titleText} — HNx`,
          body,
          description: `Discussion: ${titleText}`,
        }),
      );
      return;
    }

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
          ·
          <a href="${escapeHTML(classicItemPath(itemId))}">Classic</a>
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
    const status = error?.name === "AbortError" ? 504 : 502;

    if (isClassic) {
      sendHTML(
        res,
        status,
        renderClassicLayout({
          title: "Error — HNx",
          body: `
${renderClassicNav("best")}
<p>${escapeHTML(message)}</p>
<p><a href="${escapeHTML(classicFeedPath("best"))}">back</a></p>
`,
        }),
      );
      return;
    }

    sendHTML(
      res,
      status,
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
