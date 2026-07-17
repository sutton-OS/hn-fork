const {
  sendJSON,
  parseItemId,
  parsePositiveInt,
  parseNonNegativeInt,
  getQueryString,
  statusFromError,
  fetchCommentPage,
  UPSTREAM,
} = require("../lib/hn");

const UA = "hnx-thread/1.0";

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    sendJSON(res, 405, { error: "Method not allowed." });
    return;
  }

  const parentId = parseItemId(req.query?.id);
  if (!parentId) {
    sendJSON(res, 400, { error: "Invalid id parameter." });
    return;
  }

  const offset = parseNonNegativeInt(getQueryString(req.query?.offset), 0);
  const limit = Math.min(
    parsePositiveInt(getQueryString(req.query?.limit), UPSTREAM.threadDefaultLimit),
    UPSTREAM.threadMaxLimit,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, UPSTREAM.threadTimeoutMs);

  try {
    const payload = await fetchCommentPage(parentId, {
      offset,
      limit,
      signal: controller.signal,
      userAgent: UA,
    });

    if (!payload) {
      sendJSON(res, 404, { error: "Item not found." });
      return;
    }

    sendJSON(res, 200, payload);
  } catch (error) {
    if (error?.name === "AbortError") {
      sendJSON(res, 504, { error: "Thread request timed out." });
      return;
    }

    sendJSON(res, statusFromError(error), {
      error: error?.message || "Failed to fetch thread.",
    });
  } finally {
    clearTimeout(timer);
  }
};
