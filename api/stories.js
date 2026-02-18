const STORIES_MAP = {
  best: "beststories",
  top: "topstories",
  new: "newstories",
};

const FIREBASE_BASE = "https://hacker-news.firebaseio.com/v0";
const MAX_STORIES = 30;

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

  const rawFeed = Array.isArray(req.query?.feed) ? req.query.feed[0] : req.query?.feed;
  const feed = (rawFeed || "").toLowerCase().trim();
  if (!feed || !STORIES_MAP[feed]) {
    sendJSON(res, 400, { error: "Missing or invalid feed parameter." });
    return;
  }

  try {
    const listResp = await fetch(`${FIREBASE_BASE}/${STORIES_MAP[feed]}.json`);
    if (!listResp.ok) {
      sendJSON(res, 502, { error: `Upstream request failed (${listResp.status}).` });
      return;
    }

    const ids = await listResp.json();
    if (!Array.isArray(ids) || !ids.length) {
      sendJSON(res, 200, []);
      return;
    }

    const slice = ids.slice(0, MAX_STORIES);

    // hydrate items (parallel)
    const hyd = await Promise.all(
      slice.map(async (id) => {
        try {
          const r = await fetch(`${FIREBASE_BASE}/item/${id}.json`);
          if (!r.ok) return null;
          return r.json();
        } catch (e) {
          return null;
        }
      }),
    );

    const stories = (hyd || [])
      .filter(Boolean)
      .map((it) => ({
        id: it.id,
        title: it.title || "",
        url: it.url || "",
        domain: (() => {
          try {
            if (!it.url) return "";
            return new URL(it.url).hostname.replace(/^www\./, "");
          } catch (_) {
            return "";
          }
        })(),
        score: it.score || 0,
        by: it.by || "",
        time: it.time || 0,
        descendants: it.descendants || 0,
        kids: it.kids || [],
        text: it.text || "",
        type: it.type || "",
      }));

    sendJSON(res, 200, stories);
  } catch (error) {
    sendJSON(res, 502, { error: "Failed to fetch stories." });
  }
};
const HN_BASE_URL = "https://hacker-news.firebaseio.com/v0";
const FEEDS = { best: "beststories", top: "topstories", new: "newstories" };
const MAX_CONCURRENCY = 8;
const PAGE_SIZE = 30;
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

async function fetchWithConcurrency(ids, fetcher, limit) {
  const results = [];
  for (let i = 0; i < ids.length; i += limit) {
    const chunk = ids.slice(i, i + limit);
    const batch = await Promise.all(chunk.map(fetcher));
    results.push(...batch);
  }
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

    const topIds = ids
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)
      .slice(0, PAGE_SIZE);

    const results = await fetchWithConcurrency(
      topIds,
      (id) =>
        fetchJSON(`${HN_BASE_URL}/item/${id}.json`, { signal: controller.signal }).catch(() => null),
      MAX_CONCURRENCY,
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
