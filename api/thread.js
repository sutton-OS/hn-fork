const { sendJSON, getQueryString } = require("../lib/hn");

const THREAD_TIMEOUT_MS = 8000;
const ALGOLIA_ITEM_URL = "https://hn.algolia.com/api/v1/items";

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    sendJSON(res, 405, { error: "Method not allowed." });
    return;
  }

  const rawId = getQueryString(req.query?.id);
  const storyId = Number(rawId);
  if (!rawId || !Number.isInteger(storyId) || storyId <= 0) {
    sendJSON(res, 400, { error: "Invalid id parameter." });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, THREAD_TIMEOUT_MS);

  try {
    const upstream = await fetch(`${ALGOLIA_ITEM_URL}/${storyId}`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "hnx-thread/1.0",
      },
    });

    if (!upstream.ok) {
      sendJSON(res, upstream.status, {
        error: `Upstream request failed (${upstream.status}).`,
      });
      return;
    }

    let payload = null;
    try {
      payload = await upstream.json();
    } catch {
      sendJSON(res, 502, { error: "Upstream returned invalid JSON." });
      return;
    }

    if (!payload || typeof payload !== "object") {
      sendJSON(res, 502, { error: "Upstream returned an empty payload." });
      return;
    }

    res.status(200);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.send(JSON.stringify(payload));
  } catch (error) {
    if (error?.name === "AbortError") {
      sendJSON(res, 504, { error: "Thread request timed out." });
      return;
    }
    sendJSON(res, 502, { error: "Failed to fetch thread." });
  } finally {
    clearTimeout(timer);
  }
};
