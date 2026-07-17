const HN_BASE_URL = "https://hacker-news.firebaseio.com/v0";

/** Feed name → Firebase path segment */
const FEED_MAP = {
  best: "beststories",
  top: "topstories",
  new: "newstories",
};

const FEED_NAMES = Object.keys(FEED_MAP);

/** Shared upstream fan-out / page caps (privacy: limit amplification). */
const UPSTREAM = {
  timeoutMs: 10000,
  storiesTimeoutMs: 8000,
  threadTimeoutMs: 10000,
  concurrency: 12,
  storiesDefaultLimit: 30,
  storiesMaxLimit: 60,
  threadDefaultLimit: 40,
  threadMaxLimit: 80,
};

function sendJSON(res, status, payload) {
  res.status(status);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
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

/** Strict positive integer id from query string (blocks 1e21-style values). */
function parseItemId(raw) {
  const value = getQueryString(raw).trim();
  if (!/^\d{1,12}$/.test(value)) {
    return null;
  }
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  return id;
}

function normalizeFeed(feed) {
  const value = String(feed || "best")
    .trim()
    .toLowerCase();
  return FEED_MAP[value] ? value : "best";
}

function feedPath(feed) {
  return FEED_MAP[normalizeFeed(feed)];
}

function extractDomain(url) {
  if (typeof url !== "string" || !url) {
    return null;
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
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

  const url = typeof raw.url === "string" ? raw.url : "";

  return {
    id,
    title: typeof raw.title === "string" ? raw.title : "",
    url,
    domain: extractDomain(url),
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

/** Lean shape for list feeds — smaller payloads, faster JSON parse. */
function normalizeListItem(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }

  if (raw.deleted || raw.dead) {
    return null;
  }
  if (raw.type && raw.type !== "story" && raw.type !== "job" && raw.type !== "poll") {
    return null;
  }

  const time = Number(raw.time);
  const url = typeof raw.url === "string" ? raw.url : "";

  return {
    id,
    title: typeof raw.title === "string" ? raw.title : "",
    url,
    domain: extractDomain(url),
    time: Number.isFinite(time) ? time : 0,
  };
}

/** Comment row for progressive thread APIs (no nested tree). */
function leanComment(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }

  const kids = Array.isArray(raw.kids)
    ? raw.kids.map((kid) => Number(kid)).filter((kid) => Number.isInteger(kid) && kid > 0)
    : [];
  const time = Number(raw.time);

  return {
    id,
    by: typeof raw.by === "string" ? raw.by : "",
    time: Number.isFinite(time) ? time : 0,
    text: typeof raw.text === "string" ? raw.text : "",
    replyCount: kids.length,
    deleted: Boolean(raw.deleted),
    dead: Boolean(raw.dead),
  };
}

/** Parent story/comment metadata for thread endpoints. */
function leanParent(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }

  const time = Number(raw.time);
  const score = Number(raw.score);
  const descendants = Number(raw.descendants);
  const parent = Number(raw.parent);
  const url = typeof raw.url === "string" ? raw.url : "";

  return {
    id,
    title: typeof raw.title === "string" ? raw.title : "",
    url,
    by: typeof raw.by === "string" ? raw.by : "",
    time: Number.isFinite(time) ? time : 0,
    text: typeof raw.text === "string" ? raw.text : "",
    score: Number.isFinite(score) ? score : 0,
    type: typeof raw.type === "string" ? raw.type : "",
    descendants: Number.isFinite(descendants) ? descendants : 0,
    ...(Number.isInteger(parent) && parent > 0 ? { parent } : {}),
  };
}

async function fetchJSON(url, { signal, userAgent = "hnx/1.0" } = {}) {
  const response = await fetch(url, {
    method: "GET",
    signal,
    headers: {
      accept: "application/json",
      "user-agent": userAgent,
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

async function mapWithConcurrency(items, limit, asyncFn) {
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

function statusFromError(error, fallback = 502) {
  return error?.status && Number.isInteger(error.status) ? error.status : fallback;
}

/**
 * Fetch a page of child items for a parent HN id.
 * Returns lean comments + pagination keyed off the kid-id window (not filtered length).
 */
async function fetchCommentPage(
  parentId,
  { offset = 0, limit = UPSTREAM.threadDefaultLimit, signal, userAgent = "hnx/1.0" } = {},
) {
  const parentRaw = await fetchJSON(`${HN_BASE_URL}/item/${parentId}.json`, {
    signal,
    userAgent,
  });
  const parent = leanParent(parentRaw);
  if (!parent) {
    return null;
  }

  const kidIds = Array.isArray(parentRaw.kids)
    ? parentRaw.kids
        .map((kid) => Number(kid))
        .filter((kid) => Number.isInteger(kid) && kid > 0)
    : [];

  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.min(
    Math.max(1, limit),
    UPSTREAM.threadMaxLimit,
  );
  const pageIds = kidIds.slice(safeOffset, safeOffset + safeLimit);

  let comments = [];
  if (pageIds.length) {
    const results = await mapWithConcurrency(pageIds, UPSTREAM.concurrency, (id) =>
      fetchJSON(`${HN_BASE_URL}/item/${id}.json`, {
        signal,
        userAgent,
      }).catch(() => null),
    );
    comments = results.map((item) => leanComment(item)).filter(Boolean);
  }

  const nextOffset = safeOffset + pageIds.length;

  return {
    ...parent,
    comments,
    offset: safeOffset,
    limit: safeLimit,
    nextOffset,
    total: kidIds.length,
    hasMore: nextOffset < kidIds.length,
  };
}

module.exports = {
  HN_BASE_URL,
  FEED_MAP,
  FEED_NAMES,
  UPSTREAM,
  sendJSON,
  getQueryString,
  parsePositiveInt,
  parseNonNegativeInt,
  parseItemId,
  normalizeFeed,
  feedPath,
  extractDomain,
  normalizeItem,
  normalizeListItem,
  leanComment,
  leanParent,
  fetchJSON,
  mapWithConcurrency,
  statusFromError,
  fetchCommentPage,
};
