const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const dns = require("node:dns/promises");
const https = require("node:https");
const http = require("node:http");
const { test } = require("node:test");
const reader = require("../api/reader");
const image = require("../api/image");

function request(handler, url, { ip = "127.0.0.1", headers = {} } = {}) {
  const response = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; },
    send(body) { this.end(body); },
    end(body) { this.body = body; },
  };
  return handler({
    method: "GET", query: { url }, socket: { remoteAddress: ip },
    headers: { host: "hnx.example", ...headers },
  }, response).then(() => response);
}

function publisher(mock, resources) {
  const publicAddress = { address: "93.184.216.34", family: 4 };
  mock.method(dns, "lookup", async (hostname, options) => {
    assert.deepEqual(options, { all: true });
    if (hostname === "internal.example") return [{ address: "10.0.0.1", family: 4 }];
    if (hostname === "mixed.example") return [publicAddress, { address: "::1", family: 6 }];
    return [publicAddress];
  });
  const calls = [];
  const get = (url, options, callback) => {
    calls.push(url.href);
    assert.equal(options.agent, false);
    assert.deepEqual(Object.keys(options.headers).sort(), ["accept", "accept-encoding", "user-agent"]);
    options.lookup(url.hostname, {}, (error, address, family) => {
      assert.equal(error, null);
      assert.deepEqual({ address, family }, publicAddress);
    });
    const fixture = resources[url.pathname];
    assert.ok(fixture, `Unexpected upstream call to ${url.href}`);
    const body = Readable.from(fixture.chunks ?? [Buffer.from(fixture.html || "")]);
    body.statusCode = fixture.status ?? 200;
    body.headers = fixture.headers ?? { "content-type": "text/html; charset=utf-8" };
    queueMicrotask(() => callback(body));
    return new EventEmitter();
  };
  mock.method(https, "get", get);
  mock.method(http, "get", get);
  return calls;
}

test("reader and image refuse private destinations before opening a connection", async ({ mock }) => {
  const hits = publisher(mock, {
    "/redirect": { status: 302, headers: { location: "http://10.0.0.1/" } },
    "/redirect-name": { status: 307, headers: { location: "https://internal.example/" } },
  });
  for (const handler of [reader, image]) {
    for (const target of [
      "http://localhost/", "http://127.0.0.1/", "http://169.254.169.254/", "http://[::1]/",
      "http://[::ffff:127.0.0.1]/", "http://168.63.129.16/", "http://internal.example/",
      "http://mixed.example/", "file:///tmp/article",
    ]) {
      assert.equal((await request(handler, target)).statusCode, 400, target);
    }
    for (const target of ["redirect", "redirect-name"]) {
      assert.equal((await request(handler, `https://publisher.example/${target}`)).statusCode, 400);
    }
  }
  assert.deepEqual(hits, [
    "https://publisher.example/redirect", "https://publisher.example/redirect-name",
    "https://publisher.example/redirect", "https://publisher.example/redirect-name",
  ]);
});

test("reader extracts and caches sanitized content with final-page URLs", async ({ mock }) => {
  const story = "An original report with enough text to read in an offline article. ".repeat(7);
  const hits = publisher(mock, {
    "/story": { status: 302, headers: { location: "/news/article" } },
    "/news/article": { html: `<!doctype html><html><head><title>Test story</title>
      <base href="https://other.example/"></head><body><main>
      <h1>Test story</h1><p>${story}<a href="related">Related</a></p>
      <img src="../photo.png" alt="Photo" onerror="nothing()"><script>throw Error("script ran")</script>
      <iframe src="https://other.example/frame"></iframe><form><input></form>
      </main></body></html>` },
    "/short": { html: "<h1>Short example</h1><p>Too short.</p>" },
    "/large": { headers: { "content-type": "text/html", "content-length": String(3 * 1024 * 1024 + 1) } },
  });
  const origin = "http://hnx.example";
  const first = await request(reader, "https://publisher.example/story", {
    headers: { origin, cookie: "private", authorization: "private" },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["access-control-allow-origin"], origin);
  assert.match(first.headers["cache-control"], /^private, max-age=(?:35\d{2}|3600)$/);
  const body = JSON.parse(first.body);
  assert.equal(body.title, "Test story");
  assert.ok(body.textLength > 100);
  assert.match(body.html, /https:\/\/publisher\.example\/photo\.png/);
  assert.match(body.html, /https:\/\/publisher\.example\/news\/related/);
  assert.doesNotMatch(body.html, /onerror|<script|<iframe|<form|other\.example/);
  assert.equal((await request(reader, "https://publisher.example/story")).body, first.body);
  assert.equal(hits.length, 2);
  assert.equal((await request(reader, "https://publisher.example/short")).statusCode, 422);
  assert.equal((await request(reader, "https://publisher.example/large")).statusCode, 413);
});

test("image caps streamed bytes and checks MIME and origin", async ({ mock }) => {
  const bytes = Buffer.from("test image bytes");
  const hits = publisher(mock, {
    "/photo": { headers: { "content-type": "image/png" }, chunks: [bytes] },
    "/large": {
      headers: { "content-type": "image/webp" },
      chunks: [Buffer.alloc(2 * 1024 * 1024), Buffer.alloc(1)],
    },
    "/html": { html: "<p>HTML</p>" },
  });
  const res = await request(image, "https://publisher.example/photo");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, bytes);
  assert.equal(res.headers["content-type"], "image/png");
  assert.equal(res.headers["content-security-policy"], "sandbox; default-src 'none'");
  assert.equal((await request(image, "https://publisher.example/large")).statusCode, 413);
  assert.equal((await request(image, "https://publisher.example/html")).statusCode, 415);
  for (const handler of [reader, image]) {
    const forbidden = await request(handler, "https://publisher.example/photo", {
      headers: { origin: "https://unrelated.example" },
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.headers["access-control-allow-origin"], undefined);
  }
  assert.equal(hits.length, 3);
});

test("the reader rate limit is per client IP", async () => {
  for (let index = 0; index < 20; index += 1) {
    assert.equal((await request(reader, "http://localhost", { ip: "127.0.0.2" })).statusCode, 400);
  }
  const limited = await request(reader, "http://localhost", { ip: "127.0.0.2" });
  assert.equal(limited.statusCode, 429);
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.equal((await request(reader, "http://localhost", { ip: "127.0.0.3" })).statusCode, 400);
});
