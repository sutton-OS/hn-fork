const {
  HN_BASE_URL,
  sendJSON,
  getQueryString,
  normalizeItem,
  fetchJSON,
  statusFromError,
} = require("../lib/hn");

const ITEM_TIMEOUT_MS = 8000;
const UA = "hnx-item/1.0";

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    sendJSON(res, 405, { error: "Method not allowed." });
    return;
  }

  const rawId = getQueryString(req.query?.id);
  const id = Number(rawId);
  if (!rawId || !Number.isInteger(id) || id <= 0) {
    sendJSON(res, 400, { error: "Invalid id parameter." });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, ITEM_TIMEOUT_MS);

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

    res.status(200);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.send(JSON.stringify(item));
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
