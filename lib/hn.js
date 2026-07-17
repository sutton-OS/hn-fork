const HN_BASE_URL = "https://hacker-news.firebaseio.com/v0";

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

  // Skip non-story noise when present.
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

module.exports = {
  HN_BASE_URL,
  sendJSON,
  getQueryString,
  parsePositiveInt,
  parseNonNegativeInt,
  extractDomain,
  normalizeItem,
  normalizeListItem,
  fetchJSON,
  mapWithConcurrency,
  statusFromError,
};
