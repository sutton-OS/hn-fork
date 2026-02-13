const dns = require("node:dns/promises");
const net = require("node:net");

const REQUEST_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 1_000_000;

function sendJSON(res, status, payload) {
  res.status(status);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.send(JSON.stringify(payload));
}

function isLocalHostname(hostname) {
  const normalized = (hostname || "").toLowerCase();
  return normalized === "localhost" || normalized.endsWith(".localhost");
}

function parseIPv4(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const octets = parts.map((part) => Number(part));
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return null;
  }

  return octets;
}

function isPrivateIPv4(ip) {
  const octets = parseIPv4(ip);
  if (!octets) {
    return false;
  }

  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6(ip) {
  const normalized = ip.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }

  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isPrivateIPv4(mapped);
  }

  return false;
}

function isBlockedIP(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    return isPrivateIPv4(ip);
  }
  if (kind === 6) {
    return isPrivateIPv6(ip);
  }
  return true;
}

async function assertPublicHost(hostname) {
  if (!hostname || isLocalHostname(hostname)) {
    throw new Error("Host is not allowed.");
  }

  const directIpKind = net.isIP(hostname);
  if (directIpKind) {
    if (isBlockedIP(hostname)) {
      throw new Error("Private or local IP is not allowed.");
    }
    return;
  }

  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records.length) {
    throw new Error("Could not resolve host.");
  }

  for (const record of records) {
    if (isBlockedIP(record.address)) {
      throw new Error("Resolved host to a private or local IP.");
    }
  }
}

async function readTextWithLimit(response, maxBytes) {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const chunk = value || new Uint8Array();
    received += chunk.byteLength;
    if (received > maxBytes) {
      throw new Error("Response exceeded size limit.");
    }

    text += decoder.decode(chunk, { stream: true });
  }

  text += decoder.decode();
  return text;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    sendJSON(res, 405, { error: "Method not allowed." });
    return;
  }

  const raw = Array.isArray(req.query?.url) ? req.query.url[0] : req.query?.url;
  if (!raw || typeof raw !== "string") {
    sendJSON(res, 400, { error: "Missing url parameter." });
    return;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    sendJSON(res, 400, { error: "Invalid URL." });
    return;
  }

  if (parsed.protocol !== "https:") {
    sendJSON(res, 400, { error: "Only https URLs are allowed." });
    return;
  }

  try {
    await assertPublicHost(parsed.hostname);
  } catch (error) {
    sendJSON(res, 400, { error: error.message || "Host is not allowed." });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(parsed.href, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "hn-fork-reader/1.0",
      },
    });

    const finalUrl = new URL(response.url || parsed.href);
    if (finalUrl.protocol !== "https:") {
      sendJSON(res, 400, { error: "Redirected URL is not https." });
      return;
    }

    await assertPublicHost(finalUrl.hostname);

    if (!response.ok) {
      sendJSON(res, 502, { error: `Upstream request failed (${response.status}).` });
      return;
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      sendJSON(res, 415, { error: "URL did not return HTML." });
      return;
    }

    const html = await readTextWithLimit(response, MAX_HTML_BYTES);
    if (!html.trim()) {
      sendJSON(res, 502, { error: "Empty HTML response." });
      return;
    }

    res.status(200);
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader("x-reader-final-url", finalUrl.href);
    res.send(html);
  } catch (error) {
    if (error?.name === "AbortError") {
      sendJSON(res, 504, { error: "Reader request timed out." });
      return;
    }

    if (error?.message === "Response exceeded size limit.") {
      sendJSON(res, 413, { error: "HTML response exceeded size limit." });
      return;
    }

    sendJSON(res, 502, { error: "Failed to fetch article HTML." });
  } finally {
    clearTimeout(timer);
  }
}
