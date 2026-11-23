const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { EventEmitter } = require("node:events");
const { fetchPublic, MAX_BYTES } = require("../lib/preview-fetch");
const { frameDecision } = require("../lib/preview-api");

const signal = () => AbortSignal.timeout(2000);
const publicRecord = [{ address: "93.184.216.34", family: 4 }];
const lookup = async () => publicRecord;
function response(statusCode, headers, body = "") {
  return Object.assign(Readable.from([Buffer.from(body)]), { headers, statusCode });
}

test("private targets and mixed DNS answers are rejected before connecting", async () => {
  for (const url of ["http://localhost", "http://127.0.0.1", "http://169.254.169.254", "http://[::1]",
    "http://[::ffff:127.0.0.1]", "http://10.0.0.1", "http://100.64.0.1", "http://internal.example"]) {
    let requests = 0;
    await assert.rejects(fetchPublic(url, { signal: signal(), lookup: async () => [...publicRecord, { address: "192.168.1.1", family: 4 }],
      request: () => { requests++; } }), { status: 403 });
    assert.equal(requests, 0);
  }
  for (const raw of ["file:///article", "https://user:pass@example.org"]) {
    await assert.rejects(fetchPublic(raw, { signal: signal() }), { status: 400 });
  }
});

test("redirects resolve each hop and reject private IPs without sending a second request", async () => {
  const connections = [];
  await assert.rejects(fetchPublic("https://publisher.example/post", {
    signal: signal(), lookup, request(url, record) {
      connections.push([url.hostname, record.address]);
      return response(302, { location: "http://169.254.169.254/" });
    },
  }), { status: 403 });
  assert.deepEqual(connections, [["publisher.example", publicRecord[0].address]]);
});

test("redirect limit, streaming size cap, and DNS deadline apply", async () => {
  let hops = 0;
  await assert.rejects(fetchPublic("https://publisher.example", { lookup, signal: signal(),
    request() { hops++; return response(302, { location: "/next" }); } }), { status: 422 });
  assert.equal(hops, 6);
  await assert.rejects(fetchPublic("https://publisher.example", { lookup, signal: signal(),
    request: () => response(200, { "content-type": "text/html" }, Buffer.alloc(MAX_BYTES + 1)) }), { status: 413 });
  const controller = new AbortController();
  const pending = fetchPublic("https://publisher.example", { signal: controller.signal, lookup: () => new Promise(() => {}) });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("all enforced frame policies must allow the app origin", () => {
  const origin = "https://hnx.example";
  const check = headers => frameDecision({ url: new URL("https://publisher.example/article"),
    status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } }, origin);
  for (const policy of ["frame-ancestors 'none'", "frame-ancestors 'self'", "frame-ancestors https://other.example",
    "frame-ancestors *, frame-ancestors https://no.example", "frame-ancestors https://hnx.example:8080"]) {
    assert.equal(check({ "content-security-policy": policy }).reason, "frame-ancestors");
  }
  for (const policy of ["frame-ancestors https://hnx.example", "frame-ancestors https://*.example", "frame-ancestors https:"]) {
    assert.equal(check({ "content-security-policy": policy }).embeddable, true);
  }
  for (const header of ["DENY", "SAMEORIGIN"]) assert.equal(check({ "x-frame-options": header }).embeddable, false);
  assert.equal(check({ "content-type": "application/pdf" }).reason, "non-html");
  assert.equal(check({ "content-disposition": 'attachment; filename="page.html"' }).reason, "non-html");
});

test("API routes inspect final headers, extract sanitized content and reuse successful results", async t => {
  const probe = require("../api/embeddable");
  const reader = require("../api/reader");
  const requests = [];
  const items = new Map([
    [1, { id: 1, type: "story", url: "https://93.184.216.34/start" }],
    [2, { id: 2, type: "story", url: "https://93.184.216.34/empty" }],
    [3, { id: 3, type: "story", url: "https://93.184.216.34/start", dead: true }],
    [4, { id: 4, type: "story" }],
    [5, { id: 5, type: "comment", url: "https://93.184.216.34/start" }],
  ]);
  t.mock.method(global, "fetch", async url => {
    const match = /^https:\/\/hacker-news\.firebaseio\.com\/v0\/item\/(\d+)\.json$/.exec(url);
    assert.ok(match, `Unexpected item lookup: ${url}`);
    return { ok: true, json: async () => items.get(Number(match[1])) ?? null };
  });
  const article = '<title>Sample</title><article><h1>Sample</h1><p>' + "Readable article content. ".repeat(15) +
    '</p><img src="/photo.jpg" onload="unused()" style="float:left"><a href="more">More</a><form><input></form></article>';
  t.mock.method(require("node:https"), "request", (url, options, callback) => {
    requests.push([options.method, url.pathname, options.headers]);
    const req = new EventEmitter();
    req.end = () => {
      const page = url.pathname === "/start" ? response(302, { location: "/post" }) :
        options.method === "HEAD" ? response(405, {}) : response(200,
          { "content-type": "text/html", "x-frame-options": "DENY" }, url.pathname === "/empty" ? "<main>Loading</main>" : article);
      callback(page);
    };
    return req;
  });
  async function call(handler, query, headers = {}) {
    const req = { query, headers: { host: "hnx.example", cookie: "local", authorization: "local", ...headers },
      socket: { remoteAddress: "test" }, method: "GET" };
    const res = { headers: {}, status(code) { this.code = code; }, setHeader(k, v) { this.headers[k] = v; }, send(raw) { this.data = JSON.parse(raw); } };
    await handler(req, res);
    return res;
  }
  const start = { id: "1" };
  for (const handler of [probe, reader]) {
    const url = "https://unrelated.example/article";
    assert.equal((await call(handler, { url })).code, 400);
    assert.equal((await call(handler, { ...start, url })).code, 400);
    for (const id of ["3", "4", "5", "999"]) assert.equal((await call(handler, { id })).code, 404);
  }
  assert.deepEqual(requests, []);
  assert.equal((await call(probe, start)).data.reason, "x-frame-options");
  assert.deepEqual(requests.map(r => r.slice(0, 2)), [["HEAD", "/start"], ["HEAD", "/post"], ["GET", "/start"], ["GET", "/post"]]);
  assert.equal(requests.at(-1)[2].Range, "bytes=0-4095");
  assert.equal((await call(probe, start)).code, 200);
  assert.equal(requests.length, 4);
  const { code, data } = await call(reader, start);
  assert.equal(code, 200);
  assert.equal(data.title, "Sample");
  assert.ok(data.textLength >= 200);
  assert.match(data.html, /src="https:\/\/93\.184\.216\.34\/photo.jpg"/);
  assert.match(data.html, /href="https:\/\/93\.184\.216\.34\/more"/);
  assert.doesNotMatch(data.html, /onload|style=|<form|<input/);
  for (const [, , headers] of requests) assert.doesNotMatch(JSON.stringify(headers), /cookie|authorization/i);
  const count = requests.length;
  assert.equal((await call(reader, start)).code, 200);
  assert.equal(requests.length, count);
  assert.equal((await call(reader, { id: "2" })).code, 422);
  assert.equal((await call(reader, start, { origin: "https://elsewhere.example" })).code, 403);
  let limited;
  for (let i = 0; i < 40; i++) limited = await call(reader, start);
  assert.equal(limited.code, 429);
});
