const {
  HN_BASE_URL,
  getQueryString,
  parsePositiveInt,
  parseNonNegativeInt,
  normalizeFeed,
  feedPath,
  normalizeListItem,
  fetchJSON,
  mapWithConcurrency,
  UPSTREAM,
} = require("../../lib/hn");
const {
  normalizeTheme,
  normalizeSkin,
  plainFeedPath,
  classicFeedPath,
  renderFeedPicker,
  renderThemeLinks,
  renderLayout,
  renderClassicLayout,
  renderClassicNav,
  classicStoryListItem,
  sendHTML,
  storyListArticle,
  escapeHTML,
} = require("../../lib/html");

const UA = "hnx-html-feed/1.0";

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

  const feed = normalizeFeed(getQueryString(req.query?.feed));
  const skin = normalizeSkin(getQueryString(req.query?.skin));
  const isClassic = skin === "classic";
  const theme = normalizeTheme(getQueryString(req.query?.theme));
  const offset = parseNonNegativeInt(getQueryString(req.query?.offset), 0);
  const limit = Math.min(
    parsePositiveInt(getQueryString(req.query?.limit), UPSTREAM.storiesDefaultLimit),
    UPSTREAM.storiesMaxLimit,
  );

  const currentPath = isClassic
    ? offset > 0
      ? `/classic/${feed}?offset=${offset}`
      : `/classic/${feed}`
    : offset > 0
      ? `/plain/${feed}?offset=${offset}`
      : `/plain/${feed}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM.timeoutMs);

  try {
    const ids = await fetchJSON(`${HN_BASE_URL}/${feedPath(feed)}.json`, {
      signal: controller.signal,
      userAgent: UA,
    });

    if (!Array.isArray(ids)) {
      throw new Error("Upstream returned an invalid stories list.");
    }

    const normalizedIds = ids
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);
    const pageIds = normalizedIds.slice(offset, offset + limit);
    const nextOffset = offset + pageIds.length;
    const hasMore = nextOffset < normalizedIds.length;

    const results = pageIds.length
      ? await mapWithConcurrency(pageIds, UPSTREAM.concurrency, (id) =>
          fetchJSON(`${HN_BASE_URL}/item/${id}.json`, {
            signal: controller.signal,
            userAgent: UA,
          }).catch(() => null),
        )
      : [];

    const stories = results.map((item) => normalizeListItem(item)).filter(Boolean);

    if (isClassic) {
      const listHtml = stories.length
        ? `<ol start="${offset + 1}">\n${stories
            .map((story) => classicStoryListItem(story))
            .join("\n")}\n</ol>`
        : `<p>No stories on this page.</p>`;

      const moreHtml = hasMore
        ? `<p><a href="${escapeHTML(
            classicFeedPath(feed, { offset: nextOffset }),
          )}">More...</a></p>`
        : "";

      const body = `
${renderClassicNav(feed)}
${listHtml}
${moreHtml}
<hr>
<p><small>Classic HTML mode (no JavaScript). Double-tap <b>H</b> in the modern app to open this view.</small></p>
`;

      sendHTML(
        res,
        200,
        renderClassicLayout({
          title: `HNx — ${feed}`,
          body,
        }),
      );
      return;
    }

    const listHtml = stories.length
      ? stories.map((story) => storyListArticle(story, theme)).join("")
      : `<p class="status">No stories on this page.</p>`;

    const moreHtml = hasMore
      ? `<p class="plain-more"><a class="btn" href="${escapeHTML(
          plainFeedPath(feed, theme, { offset: nextOffset }),
        )}">More stories</a></p>`
      : "";

    const body = `
      <section class="list-pane">
        <header class="topbar">
          <div class="topbar-start">
            <div class="feed-picker" role="group" aria-label="Story feed">
              ${renderFeedPicker(feed, theme)}
            </div>
          </div>
          <div class="topbar-actions">
            ${renderThemeLinks(theme, currentPath)}
          </div>
        </header>
        <p class="plain-banner status">
          Plain HTML mode (no JavaScript).
          <a href="/">Full app</a>
          ·
          <a href="${escapeHTML(classicFeedPath(feed))}">Classic</a>
        </p>
        <section class="story-list">
          ${listHtml}
        </section>
        ${moreHtml}
      </section>
    `;

    sendHTML(
      res,
      200,
      renderLayout({
        title: `HNx — ${feed}`,
        theme,
        body,
      }),
    );
  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? "Request timed out."
        : error?.message || "Failed to load feed.";
    const status = error?.name === "AbortError" ? 504 : 502;

    if (isClassic) {
      sendHTML(
        res,
        status,
        renderClassicLayout({
          title: "Error — HNx",
          body: `
${renderClassicNav(feed)}
<p>${escapeHTML(message)}</p>
<p><a href="${escapeHTML(classicFeedPath(feed))}">Retry</a></p>
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
                <div class="feed-picker">${renderFeedPicker(feed, theme)}</div>
              </div>
              <div class="topbar-actions">${renderThemeLinks(theme, currentPath)}</div>
            </header>
            <p class="status">${escapeHTML(message)}</p>
            <p><a class="btn" href="${escapeHTML(plainFeedPath(feed, theme))}">Retry</a></p>
          </section>
        `,
      }),
    );
  } finally {
    clearTimeout(timer);
  }
};
