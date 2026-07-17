const {
  HN_BASE_URL,
  sendJSON,
  getQueryString,
  parsePositiveInt,
  parseNonNegativeInt,
  fetchJSON,
  mapWithConcurrency,
  statusFromError,
} = require("../lib/hn");

const THREAD_TIMEOUT_MS = 10000;
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 80;
const MAX_CONCURRENCY = 28;
const UA = "hnx-thread/1.0";

/**
 * Lean comment for the client: direct replyCount only (no nested tree).
 * Keeps first paint small — same idea as /api/stories list rows.
 */
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
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    sendJSON(res, 405, { error: "Method not allowed." });
    return;
  }

  const rawId = getQueryString(req.query?.id);
  const parentId = Number(rawId);
  if (!rawId || !Number.isInteger(parentId) || parentId <= 0) {
    sendJSON(res, 400, { error: "Invalid id parameter." });
    return;
  }

  const offset = parseNonNegativeInt(getQueryString(req.query?.offset), 0);
  const limit = Math.min(
    parsePositiveInt(getQueryString(req.query?.limit), DEFAULT_LIMIT),
    MAX_LIMIT,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, THREAD_TIMEOUT_MS);

  try {
    const parentRaw = await fetchJSON(`${HN_BASE_URL}/item/${parentId}.json`, {
      signal: controller.signal,
      userAgent: UA,
    });

    const parent = leanParent(parentRaw);
    if (!parent) {
      sendJSON(res, 404, { error: "Item not found." });
      return;
    }

    const kidIds = Array.isArray(parentRaw.kids)
      ? parentRaw.kids
          .map((kid) => Number(kid))
          .filter((kid) => Number.isInteger(kid) && kid > 0)
      : [];

    const pageIds = kidIds.slice(offset, offset + limit);
    let comments = [];

    if (pageIds.length) {
      const results = await mapWithConcurrency(pageIds, MAX_CONCURRENCY, (id) =>
        fetchJSON(`${HN_BASE_URL}/item/${id}.json`, {
          signal: controller.signal,
          userAgent: UA,
        }).catch(() => null),
      );
      comments = results.map((item) => leanComment(item)).filter(Boolean);
    }

    const payload = {
      ...parent,
      comments,
      offset,
      limit,
      total: kidIds.length,
      hasMore: offset + pageIds.length < kidIds.length,
    };

    res.status(200);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.send(JSON.stringify(payload));
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
