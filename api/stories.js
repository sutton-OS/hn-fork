const {
  HN_BASE_URL,
  sendJSON,
  getQueryString,
  parsePositiveInt,
  parseNonNegativeInt,
  normalizeFeed,
  feedPath,
  normalizeListItem,
  fetchJSON,
  mapWithConcurrency,
  statusFromError,
  UPSTREAM,
} = require("../lib/hn");

const UA = "hnx-stories/1.0";

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    sendJSON(res, 405, { error: "Method not allowed." });
    return;
  }

  const feed = normalizeFeed(getQueryString(req.query?.feed));
  const offset = parseNonNegativeInt(getQueryString(req.query?.offset), 0);
  const limit = Math.min(
    parsePositiveInt(getQueryString(req.query?.limit), UPSTREAM.storiesDefaultLimit),
    UPSTREAM.storiesMaxLimit,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, UPSTREAM.storiesTimeoutMs);

  try {
    const ids = await fetchJSON(`${HN_BASE_URL}/${feedPath(feed)}.json`, {
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
    const nextOffset = offset + pageIds.length;
    const hasMore = nextOffset < normalizedIds.length;

    let stories = [];
    if (pageIds.length) {
      const results = await mapWithConcurrency(
        pageIds,
        UPSTREAM.concurrency,
        (id) =>
          fetchJSON(`${HN_BASE_URL}/item/${id}.json`, {
            signal: controller.signal,
            userAgent: UA,
          }).catch(() => null),
      );
      stories = results.map((item) => normalizeListItem(item)).filter(Boolean);
    }

    // Structured pagination: nextOffset advances by id-window, not filtered length.
    sendJSON(res, 200, {
      feed,
      stories,
      offset,
      limit,
      nextOffset,
      total: normalizedIds.length,
      hasMore,
    });
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
