const {
  sendJSON,
  parseItemId,
  parsePositiveInt,
  parseNonNegativeInt,
  getQueryString,
  statusFromError,
  fetchCommentPage,
  UPSTREAM,
} = require("../lib/hn");

const UA = "hnx-thread/1.0";

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    sendJSON(res, 405, { error: "Method not allowed." });
    return;
  }

  const parentId = parseItemId(req.query?.id);
  if (!parentId) {
    sendJSON(res, 400, { error: "Invalid id parameter." });
    return;
  }

  const offset = parseNonNegativeInt(getQueryString(req.query?.offset), 0);
  const limit = Math.min(
    parsePositiveInt(getQueryString(req.query?.limit), UPSTREAM.threadDefaultLimit),
    UPSTREAM.threadMaxLimit,
  );

  const controller = new AbortController();
  const stream = req.query?.stream === "1";
  let disconnected = false;
  const stop = () => {
    disconnected = true;
    controller.abort();
  };
  req.on("error", stop);
  res.once("close", stop);
  const timer = setTimeout(() => {
    controller.abort();
  }, UPSTREAM.threadTimeoutMs);

  try {
    const payload = await fetchCommentPage(parentId, {
      offset,
      limit,
      signal: controller.signal,
      userAgent: UA,
      onParent: stream ? (parent) => {
        res.status(200);
        res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.write(JSON.stringify({ parent }) + "\n");
      } : undefined,
    });

    if (!payload) {
      sendJSON(res, 404, { error: "Item not found." });
      return;
    }

    if (stream) {
      const { comments, nextOffset, total, hasMore } = payload;
      res.end(JSON.stringify({ thread: { comments, nextOffset, total, hasMore } }) + "\n");
    } else {
      sendJSON(res, 200, payload);
    }
  } catch (error) {
    if (disconnected || res.destroyed) {
      if (!res.destroyed) res.end();
      return;
    }
    const timedOut = error?.name === "AbortError";
    const message = timedOut ? "Thread request timed out." : error?.message || "Failed to fetch thread.";
    if (res.headersSent) {
      res.end(JSON.stringify({ error: message }) + "\n");
    } else {
      sendJSON(res, timedOut ? 504 : statusFromError(error), { error: message });
    }
  } finally {
    clearTimeout(timer);
    req.removeListener("error", stop);
    res.removeListener("close", stop);
    controller.abort();
  }
};
