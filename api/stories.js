const HN_BASE_URL = "https://hacker-news.firebaseio.com/v0";
const FEEDS = { best: "beststories", top: "topstories", new: "newstories" };
const MAX_CONCURRENCY = 12;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 120;
const STORIES_CACHE_CONTROL = "s-maxage=90, stale-while-revalidate=30";
const STORIES_TIMEOUT_MS = 8000;

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

function parsePositiveInt(raw, fallback) {
  const numeric = Number(raw);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return fallback;
  }
  return numeric;
}

function parseNonNegativeInt(raw, fallback) {
  const numeric = Number(raw);
  if (!Number.isInteger(numeric) || numeric < 0) {
    return fallback;
  }
  return numeric;
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
    domain:
      typeof raw.url === "string" && raw.url
        ? (() => {
            try {
              return new URL(raw.url).hostname.replace(/^www\./, "");
            } catch {
              return null;
            }
          })()
        : null,
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
      "user-agent": "hn-fork-stories/1.0",
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

async function mapWithConcurrency(items, limit, asyncFn, { signal } = {}) {
  if (!items.length) {
    return [];
  }

  const results = new Array(items.length);
  const workerCount = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await asyncFn(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

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
      res.setHeader("cache-control", STORIES_CACHE_CONTROL);
      res.send("[]");
      return;
    }

    const results = await mapWithConcurrency(
      pageIds,
      MAX_CONCURRENCY,
      (id) =>
        fetchJSON(`${HN_BASE_URL}/item/${id}.json`, { signal: controller.signal }).catch(() => null),
      { signal: controller.signal },
    );

    const stories = results.map((item) => normalizeItem(item)).filter((item) => item);

    res.status(200);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", STORIES_CACHE_CONTROL);
    res.send(JSON.stringify(stories));
  } catch (error) {
    if (error?.name === "AbortError") {
      sendJSON(res, 504, { error: "Stories request timed out." });
      return;
    }

    sendJSON(res, error?.status && Number.isInteger(error.status) ? error.status : 502, {
      error: error?.message || "Failed to fetch stories.",
    });
  } finally {
    clearTimeout(timer);
  }
};
