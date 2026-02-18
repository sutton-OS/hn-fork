const HN_BASE_URL = "https://hacker-news.firebaseio.com/v0";
const ITEM_TIMEOUT_MS = 8000;
const ITEM_CACHE_CONTROL = "s-maxage=180, stale-while-revalidate=60";

function sendJSON(res, status, payload) {
  res.status(status);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.send(JSON.stringify(payload));
}

function getQueryString(value) {
  if (Array.isArray(value)) {
    return value[0] || "";
  }
  return typeof value === "string" ? value : "";
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }

  const score = Number(raw.score);
  const time = Number(raw.time);
  const descendants = Number(raw.descendants);
  const parent = Number(raw.parent);
  const kids = Array.isArray(raw.kids)
    ? raw.kids
        .map((kid) => Number(kid))
        .filter((kid) => Number.isInteger(kid) && kid > 0)
    : [];

  return {
    id,
    title: typeof raw.title === "string" ? raw.title : "",
    url: typeof raw.url === "string" ? raw.url : "",
    score: Number.isFinite(score) ? score : 0,
    by: typeof raw.by === "string" ? raw.by : "",
    time: Number.isFinite(time) ? time : 0,
    descendants: Number.isFinite(descendants) ? descendants : 0,
    kids,
    text: typeof raw.text === "string" ? raw.text : "",
    type: typeof raw.type === "string" ? raw.type : "",
    deleted: Boolean(raw.deleted),
    dead: Boolean(raw.dead),
    ...(Number.isInteger(parent) && parent > 0 ? { parent } : {}),
  };
}

async function fetchJSON(url, { signal }) {
  const response = await fetch(url, {
    method: "GET",
    signal,
    headers: {
      accept: "application/json",
      "user-agent": "hn-fork-item/1.0",
    },
  });

  if (!response.ok) {
    const error = new Error(`Upstream request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }

  try {
    return await response.json();
  } catch {
    const error = new Error("Upstream returned invalid JSON.");
    error.status = 502;
    throw error;
  }
}

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
    });

    const item = normalizeItem(rawItem);
    if (!item) {
      sendJSON(res, 404, { error: "Item not found." });
      return;
    }

    res.status(200);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", ITEM_CACHE_CONTROL);
    res.send(JSON.stringify(item));
  } catch (error) {
    if (error?.name === "AbortError") {
      sendJSON(res, 504, { error: "Item request timed out." });
      return;
    }

    sendJSON(res, error?.status && Number.isInteger(error.status) ? error.status : 502, {
      error: error?.message || "Failed to fetch item.",
    });
  } finally {
    clearTimeout(timer);
  }
};
