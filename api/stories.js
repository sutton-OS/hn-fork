const {
  HN_BASE_URL,
  sendJSON,
  getQueryString,
  parsePositiveInt,
  parseNonNegativeInt,
  normalizeListItem,
  fetchJSON,
  mapWithConcurrency,
  statusFromError,
} = require("../lib/hn");

const FEEDS = { best: "beststories", top: "topstories", new: "newstories" };
const MAX_CONCURRENCY = 40;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 120;
const STORIES_TIMEOUT_MS = 8000;
const UA = "hnx-stories/1.0";

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    sendJSON(res, 405, { error: "Method not allowed." });
    return;
  }

  const feed = getQueryString(req.query?.feed).trim().toLowerCase();
  const feedKey = FEEDS[feed] || FEEDS.best;
  const offset = parseNonNegativeInt(getQueryString(req.query?.offset), 0);
  const limit = Math.min(
    parsePositiveInt(getQueryString(req.query?.limit), DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, STORIES_TIMEOUT_MS);

  try {
    const ids = await fetchJSON(`${HN_BASE_URL}/${feedKey}.json`, {
      signal: controller.signal,
      userAgent: UA,
    });

    if (!Array.isArray(ids)) {
      sendJSON(res, 502, { error: "Upstream returned an invalid stories list." });
      return;
    }

    const normalizedIds = ids
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);
    const pageIds = normalizedIds.slice(offset, offset + limit);

    if (!pageIds.length) {
      res.status(200);
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.send("[]");
      return;
    }

    const results = await mapWithConcurrency(pageIds, MAX_CONCURRENCY, (id) =>
      fetchJSON(`${HN_BASE_URL}/item/${id}.json`, {
        signal: controller.signal,
        userAgent: UA,
      }).catch(() => null),
    );

    const stories = results.map((item) => normalizeListItem(item)).filter(Boolean);

    res.status(200);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.send(JSON.stringify(stories));
  } catch (error) {
    if (error?.name === "AbortError") {
      sendJSON(res, 504, { error: "Stories request timed out." });
      return;
    }

    sendJSON(res, statusFromError(error), {
      error: error?.message || "Failed to fetch stories.",
    });
  } finally {
    clearTimeout(timer);
  }
};
