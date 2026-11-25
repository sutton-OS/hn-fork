const { sendJSON, getQueryString, parsePositiveInt, parseNonNegativeInt, UPSTREAM } = require("./hn");
const { createWsjSource } = require("./wsj");

const getStories = createWsjSource();

/** Cache only the URLs the app requests, so other query strings cannot inflate the cache. */
function isStandardPage(query = {}) {
  const { storiesInitialLimit: first, storiesDefaultLimit: rest } = UPSTREAM;
  if (!Object.keys(query).every((key) => ["feed", "offset", "limit"].includes(key)) || query.feed !== "wsj") return false;
  if (query.offset === "0") return query.limit === String(first);
  const offset = Number(query.offset);
  return String(offset) === query.offset && query.limit === String(rest) &&
    offset >= first && offset <= 999 && (offset - first) % rest === 0;
}

/** Serves /api/stories?feed=wsj, which checks the method. */
module.exports = async function sendWsjStories(req, res) {
  const offset = parseNonNegativeInt(getQueryString(req.query?.offset), 0);
  const limit = Math.min(
    parsePositiveInt(getQueryString(req.query?.limit), UPSTREAM.storiesDefaultLimit),
    UPSTREAM.storiesMaxLimit,
  );

  try {
    const { stories, partial } = await getStories({ fresh: getQueryString(req.query?.fresh) === "1" });
    const page = stories.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    sendJSON(res, 200, {
      feed: "wsj",
      stories: page,
      offset,
      limit,
      nextOffset,
      total: stories.length,
      hasMore: nextOffset < stories.length,
    }, { cacheFeed: !partial && isStandardPage(req.query) });
  } catch (error) {
    const timeout = ["TimeoutError", "AbortError"].includes(error?.name);
    sendJSON(res, timeout ? 504 : 502, {
      error: timeout ? "Wall Street Journal request timed out." : "Wall Street Journal stories are unavailable.",
    });
  }
};
