// Resolve every hop once and connect to the vetted address. Keep the URL hostname
// on the request so Host, SNI and TLS certificate validation still work.
const dns = require("node:dns/promises");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const ipaddr = require("ipaddr.js");
const { addAbortListener } = require("node:events");

const MAX_BYTES = 3 * 1024 * 1024;
class PreviewError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function publicURL(raw) {
  let url;
  try { url = new URL(raw); } catch {}
  if (!url || typeof raw !== "string" || raw.length > 4096 ||
      !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new PreviewError(400, "A public HTTP or HTTPS URL is required.");
  }
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      (!host.includes(".") && !host.includes(":"))) {
    throw new PreviewError(403, "Private destinations are unavailable.");
  }
  url.hash = "";
  return url;
}

function isPublicAddress(address) {
  const ip = ipaddr.parse(address);
  return ip.range() === "unicast" && (ip.kind() === "ipv4" ?
    address !== "168.63.129.16" : ip.match(ipaddr.parse("2000::"), 3));
}

async function resolvePublic(url, lookup = dns.lookup) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const family = net.isIP(host);
  const records = family ? [{ address: host, family }] : await lookup(host, { all: true, verbatim: true });
  if (!records.length || !records.every(record => isPublicAddress(record.address))) {
    throw new PreviewError(403, "Private destinations are unavailable.");
  }
  return records.find(record => record.family === 4) || records[0];
}

function connect(url, record, method, signal, range, accept) {
  const transport = url.protocol === "https:" ? https : http;
  const headers = { "User-Agent": "HNx-LinkPreview/1.0", Accept: accept, "Accept-Encoding": "identity" };
  if (range) headers.Range = "bytes=0-4095";
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method, headers, signal, agent: false, family: record.family, autoSelectFamily: false,
      lookup: (_host, _options, callback) => callback(null, record.address, record.family),
    }, resolve);
    req.on("error", reject);
    req.end();
  });
}

async function untilAbort(promise, signal) {
  signal.throwIfAborted();
  let subscription;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      subscription = addAbortListener(signal, () => reject(signal.reason));
    })]);
  } finally {
    subscription?.[Symbol.dispose]();
  }
}

async function fetchPublic(raw, { method = "GET", headersOnly = false, signal, lookup, request = connect,
  accept = "text/html, application/xhtml+xml", accepts = isHTML, maxBytes = MAX_BYTES }) {
  let url = publicURL(raw);
  for (let hop = 0; hop <= 5; hop++) {
    const record = await untilAbort(resolvePublic(url, lookup), signal);
    signal.throwIfAborted();
    const response = await request(url, record, method, signal, headersOnly && method === "GET", accept);
    const { headers, statusCode: status } = response;
    try {
      if ([301, 302, 303, 307, 308].includes(status) && headers.location) {
        url = publicURL(new URL(headers.location, url).href);
        continue;
      }
      if (headersOnly || status < 200 || status >= 300 || !accepts(headers)) return { url, headers, status };
      if (headers["content-encoding"] && headers["content-encoding"] !== "identity") {
        throw new PreviewError(422, "Unsupported article encoding.");
      }
      if (Number(headers["content-length"]) > maxBytes) throw new PreviewError(413, "Response is too large.");
      const chunks = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > maxBytes) throw new PreviewError(413, "Response is too large.");
        chunks.push(chunk);
      }
      return { url, headers, status, body: Buffer.concat(chunks, size) };
    } finally {
      response.destroy();
    }
  }
  throw new PreviewError(422, "Too many redirects.");
}

function isHTML(headers) {
  return !/^\s*attachment\b/i.test(headers["content-disposition"] || "") &&
    /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(headers["content-type"] || "");
}

module.exports = { publicURL, fetchPublic, isHTML, untilAbort, PreviewError, MAX_BYTES };
