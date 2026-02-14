const THREAD_TIMEOUT_MS = 8000;
const THREAD_CACHE_CONTROL = "s-maxage=60, stale-while-revalidate=600";

function sendJSON(res, status, payload) {
  res.status(status);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.send(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    sendJSON(res, 405, { error: "Method not allowed." });
    return;
  }

  const rawId = Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id;
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
    const upstream = await fetch(`https://hn.algolia.com/api/v1/items/${storyId}`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "hn-fork-thread/1.0",
      },
    });

    if (!upstream.ok) {
      sendJSON(res, upstream.status, { error: `Upstream request failed (${upstream.status}).` });
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
    res.setHeader("cache-control", THREAD_CACHE_CONTROL);
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
