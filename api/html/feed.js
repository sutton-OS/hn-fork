const {
  HN_BASE_URL,
  getQueryString,
  parsePositiveInt,
  parseNonNegativeInt,
  normalizeListItem,
  fetchJSON,
  mapWithConcurrency,
} = require("../../lib/hn");
const {
  normalizeFeed,
  normalizeTheme,
  plainFeedPath,
  renderFeedPicker,
  renderThemeLinks,
  renderLayout,
  sendHTML,
  storyListArticle,
  escapeHTML,
} = require("../../lib/html");

const FEEDS = { best: "beststories", top: "topstories", new: "newstories" };
const MAX_CONCURRENCY = 40;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 60;
const TIMEOUT_MS = 10000;
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
  const theme = normalizeTheme(getQueryString(req.query?.theme));
  const offset = parseNonNegativeInt(getQueryString(req.query?.offset), 0);
  const limit = Math.min(
    parsePositiveInt(getQueryString(req.query?.limit), DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );

  const currentPath =
    offset > 0 ? `/plain/${feed}?offset=${offset}` : `/plain/${feed}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const ids = await fetchJSON(`${HN_BASE_URL}/${FEEDS[feed]}.json`, {
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

    const results = pageIds.length
      ? await mapWithConcurrency(pageIds, MAX_CONCURRENCY, (id) =>
          fetchJSON(`${HN_BASE_URL}/item/${id}.json`, {
            signal: controller.signal,
            userAgent: UA,
          }).catch(() => null),
        )
      : [];

    const stories = results.map((item) => normalizeListItem(item)).filter(Boolean);
    const nextOffset = offset + pageIds.length;
    const hasMore = nextOffset < normalizedIds.length;

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
          <a href="/">Full app</a> ·
          <a href="${escapeHTML(plainFeedPath(feed, theme))}">Best/Top/New</a>
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
