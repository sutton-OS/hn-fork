const { isIP } = require("node:net");
const { sendJSON } = require("./hn");
const { FetchError, parseUrl } = require("./public-fetch");

const ONE_MINUTE = 60_000;

function articleRoute(handle, perMinute) {
  const clients = new Map();

  return async (req, res) => {
    const headers = req.headers || {};
    const onVercel = process.env.VERCEL === "1";
    const protocol = onVercel ? headers["x-forwarded-proto"] : req.socket?.encrypted ? "https" : "http";
    const origin = headers.origin;
    res.setHeader("Vary", "Origin, Sec-Fetch-Site");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");

    if ((origin && origin !== `${protocol}://${headers.host}`) ||
        ["cross-site", "same-site"].includes(headers["sec-fetch-site"])) {
      return sendJSON(res, 403, { error: "This endpoint accepts same-origin requests only." });
    }
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return sendJSON(res, 405, { error: "Method not allowed." });
    }

    const forwarded = headers["x-vercel-forwarded-for"];
    const ip = onVercel && typeof forwarded === "string" && isIP(forwarded)
      ? forwarded : req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    // Entries are in expiration order and the table has a fixed upper bound.
    for (const [key, entry] of clients) {
      if (entry.until > now) break;
      clients.delete(key);
    }
    let entry = clients.get(ip);
    if (!entry && clients.size < 10_000) {
      entry = { until: now + ONE_MINUTE, count: 0 };
      clients.set(ip, entry);
    }
    if (!entry || entry.count >= perMinute) {
      res.setHeader("Retry-After", String(Math.ceil(((entry?.until ?? now + ONE_MINUTE) - now) / 1000)));
      return sendJSON(res, 429, { error: "Too many offline copy requests. Try again in a minute." });
    }
    entry.count += 1;

    try {
      const input = req.query?.url;
      if (typeof input !== "string" || !input.trim() || input.length > 4096) {
        throw new FetchError(400, "Enter a valid article or image URL.");
      }
      await handle(parseUrl(input).href, res);
    } catch (error) {
      sendJSON(res, error instanceof FetchError ? error.status : 502, {
        error: error instanceof FetchError ? error.message : "Could not prepare offline content.",
      });
    }
  };
}

module.exports = { articleRoute };
