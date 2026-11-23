const { fetchPublic, isHTML, publicURL, PreviewError } = require("./preview-fetch");
const { HN_BASE_URL, fetchJSON, normalizeListItem, parseItemId, sendJSON } = require("./hn");

function cache(limit) {
  const values = new Map();
  return {
    get(key) {
      const entry = values.get(key);
      if (entry?.expires > Date.now()) return entry.value;
      values.delete(key);
    },
    put(key, value, ttl) {
      values.delete(key);
      if (values.size >= limit) values.delete(values.keys().next().value);
      values.set(key, { value, expires: Date.now() + ttl });
    },
  };
}

const clients = new Map();
function withinLimit(ip) {
  const now = Date.now();
  let entry = clients.get(ip);
  if (!entry || entry.until <= now) {
    // Entries are ordered by window start. Keep even a burst of distinct IPs bounded.
    for (const [key, value] of clients) {
      if (value.until > now) break;
      clients.delete(key);
    }
    if (clients.size >= 10000) return false;
    entry = { count: 0, until: now + 60000 };
    clients.set(ip, entry);
  }
  return ++entry.count <= 40;
}

function endpoint(action) {
  return async (req, res) => {
    try {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        throw new PreviewError(405, "Use GET.");
      }
      const tls = req.socket?.encrypted || (process.env.VERCEL && req.headers["x-forwarded-proto"] !== "http");
      const scheme = tls ? "https" : "http";
      const origin = new URL(scheme + "://" + req.headers.host).origin;
      res.setHeader("Vary", "Origin");
      if ((req.headers.origin && req.headers.origin !== origin) || req.headers["sec-fetch-site"] === "cross-site") {
        throw new PreviewError(403, "Cross-origin preview requests are unavailable.");
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      const forwarded = process.env.VERCEL && (req.headers["x-vercel-forwarded-for"] || req.headers["x-forwarded-for"]);
      const ip = forwarded || req.socket?.remoteAddress || "local";
      if (!withinLimit(ip)) {
        res.setHeader("Retry-After", "60");
        throw new PreviewError(429, "Too many preview requests.");
      }
      const id = parseItemId(req.query?.id);
      if (!id || req.query?.url !== undefined) throw new PreviewError(400, "A Hacker News story ID is required.");
      const signal = AbortSignal.timeout(8000);
      const item = normalizeListItem(await fetchJSON(`${HN_BASE_URL}/item/${id}.json`, {
        signal, userAgent: "hnx-preview/1.0",
      }));
      if (item?.id !== id || !item.url) throw new PreviewError(404, "No publisher link for this Hacker News story.");
      sendJSON(res, 200, await action(publicURL(item.url), origin, signal));
    } catch (error) {
      const timeout = ["TimeoutError", "AbortError"].includes(error.name);
      sendJSON(res, error.status || (timeout ? 504 : 502), {
        error: error instanceof PreviewError ? error.message : timeout ? "Preview timed out." : "Publisher unavailable.",
      });
    }
  };
}

function permitsAncestor(source, origin, publisher) {
  const ancestor = new URL(origin);
  const token = source.toLowerCase();
  if (token === "*") return true;
  if (token === "'self'") return ancestor.origin === publisher.origin;
  if (/^https?:$/.test(token)) return token === ancestor.protocol || (token === "http:" && ancestor.protocol === "https:");
  const match = /^(?:(https?):\/\/)?(\*|(?:\*\.)?[\w.-]+|\[[a-f\d:]+\])(?::(\*|\d+))?\/?$/i.exec(token);
  if (!match) return false;
  const [, scheme, host, port] = match;
  const protocol = scheme ? scheme + ":" : publisher.protocol;
  if (protocol !== ancestor.protocol && !(protocol === "http:" && ancestor.protocol === "https:")) return false;
  const actualPort = ancestor.port || (ancestor.protocol === "https:" ? "443" : "80");
  if (port && port !== "*" && port !== actualPort) return false;
  if (!port && ancestor.port) return false;
  return host === "*" || host === ancestor.hostname || (host.startsWith("*.") && ancestor.hostname.endsWith(host.slice(1)));
}

function frameDecision({ headers, url, status }, origin) {
  if (status < 200 || status >= 300) return { embeddable: false, reason: "publisher-status" };
  if (!isHTML(headers)) return { embeddable: false, reason: "non-html" };
  if (url.origin === origin || (url.protocol === "http:" && origin.startsWith("https:"))) {
    return { embeddable: false, reason: "origin" };
  }
  if (/\b(?:DENY|SAMEORIGIN|ALLOW-FROM)\b/i.test(headers["x-frame-options"] || "")) {
    return { embeddable: false, reason: "x-frame-options" };
  }
  for (const policy of (headers["content-security-policy"] || "").split(",")) {
    const directive = policy.split(";").map(part => part.trim().split(/\s+/))
      .find(([name]) => name.toLowerCase() === "frame-ancestors");
    if (directive && !directive.slice(1).some(source => permitsAncestor(source, origin, url))) {
      return { embeddable: false, reason: "frame-ancestors" };
    }
  }
  return { embeddable: true, reason: "allowed", finalUrl: url.href };
}

const decisions = cache(1024);
async function embeddable(url, origin, signal) {
  const key = origin + " " + url.origin;
  const hit = decisions.get(key);
  // Headers, redirects and downloads can vary across paths on one publisher.
  if (hit?.href === url.href) return hit.decision;
  let result = await fetchPublic(url.href, { method: "HEAD", signal, headersOnly: true });
  if (result.status < 200 || result.status >= 300 || !result.headers["content-type"]) {
    result = await fetchPublic(url.href, { signal, headersOnly: true });
  }
  const decision = frameDecision(result, origin);
  if (decision.reason !== "publisher-status") decisions.put(key, { href: url.href, decision }, 86400000);
  return decision;
}
module.exports = { cache, endpoint, embeddable, frameDecision };
