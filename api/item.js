const {
  HN_BASE_URL,
  sendJSON,
  parseItemId,
  normalizeItem,
  fetchJSON,
  statusFromError,
  UPSTREAM,
} = require("../lib/hn");

const UA = "hnx-item/1.0";

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    sendJSON(res, 405, { error: "Method not allowed." });
    return;
  }

  const id = parseItemId(req.query?.id);
  if (!id) {
    sendJSON(res, 400, { error: "Invalid id parameter." });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, UPSTREAM.storiesTimeoutMs);

  try {
    const rawItem = await fetchJSON(`${HN_BASE_URL}/item/${id}.json`, {
      signal: controller.signal,
      userAgent: UA,
    });

    const item = normalizeItem(rawItem);
    if (!item) {
      sendJSON(res, 404, { error: "Item not found." });
      return;
    }

    sendJSON(res, 200, item);
  } catch (error) {
    if (error?.name === "AbortError") {
      sendJSON(res, 504, { error: "Item request timed out." });
      return;
    }

    sendJSON(res, statusFromError(error), {
      error: error?.message || "Failed to fetch item.",
    });
  } finally {
    clearTimeout(timer);
  }
};
