const dns = require("node:dns/promises");
const http = require("node:http");
const https = require("node:https");
const { isIP } = require("node:net");
const { addAbortListener } = require("node:events");
const ipaddr = require("ipaddr.js");

class FetchError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const globalIPv6 = ipaddr.parse("2000::");

function isPublicAddress(address) {
  const ip = ipaddr.parse(address);
  return ip.range() === "unicast" &&
    (ip.kind() === "ipv4" ? ip.toString() !== "168.63.129.16" : ip.match(globalIPv6, 3));
}

function parseUrl(input, base) {
  let url;
  try {
    url = new URL(input, base);
  } catch {
    throw new FetchError(400, "Enter a valid article or image URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) {
    throw new FetchError(400, "Only public HTTP and HTTPS URLs on their default ports are supported.");
  }
  url.hash = "";
  return url;
}

async function lookupWithTimeout(host, signal) {
  let abort;
  try {
    return await Promise.race([
      dns.lookup(host, { all: true }),
      new Promise((_, reject) => {
        abort = addAbortListener(signal, () => reject(signal.reason));
      }),
    ]);
  } finally {
    abort?.[Symbol.dispose]();
  }
}

async function requestPublicUrl(url, { signal, accept }) {
  signal.throwIfAborted();
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(?:.*\.)?localhost\.?$/i.test(host)) {
    throw new FetchError(400, "The URL must resolve to a public address.");
  }

  const family = isIP(host);
  const addresses = family ? [{ address: host, family }] : await lookupWithTimeout(host, signal);
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new FetchError(400, "The URL must resolve to a public address.");
  }
  const pinned = addresses.find(({ family }) => family === 4) || addresses[0];
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.get(url, {
      agent: false,
      signal,
      family: pinned.family,
      // Preserve the hostname for Host and TLS while connecting to the checked address.
      lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
      headers: { accept, "accept-encoding": "identity", "user-agent": "HNx Reader/1.0" },
    }, resolve);
    request.on("error", reject);
  });
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

async function fetchPublic(input, { accept, acceptsType, maxBytes }) {
  let url = parseUrl(input);
  const signal = AbortSignal.timeout(8000);

  try {
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const response = await requestPublicUrl(url, { signal, accept });
      try {
        const { statusCode, headers } = response;
        if (REDIRECTS.has(statusCode) && headers.location && redirects < 5) {
          url = parseUrl(headers.location, url);
          continue;
        }
        if (statusCode < 200 || statusCode >= 300) {
          throw new FetchError(502, "The publisher did not return the requested content.");
        }
        const type = (headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
        if (!acceptsType(type)) throw new FetchError(415, "The publisher returned an unsupported content type.");
        if (headers["content-encoding"] && headers["content-encoding"].toLowerCase() !== "identity") {
          throw new FetchError(415, "The publisher did not return uncompressed content.");
        }
        if (Number(headers["content-length"]) > maxBytes) {
          throw new FetchError(413, "The publisher response is too large.");
        }

        const chunks = [];
        let size = 0;
        for await (const chunk of response) {
          size += chunk.length;
          if (size > maxBytes) throw new FetchError(413, "The publisher response is too large.");
          chunks.push(chunk);
        }
        return { url: url.href, type, contentType: headers["content-type"], bytes: Buffer.concat(chunks, size) };
      } finally {
        response.destroy();
      }
    }
  } catch (error) {
    if (error instanceof FetchError) throw error;
    if (signal.aborted) throw new FetchError(504, "The publisher request timed out.");
    throw new FetchError(502, "Could not connect to the publisher.");
  }
}

module.exports = { fetchPublic, FetchError, parseUrl };
