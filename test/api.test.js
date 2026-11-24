const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { fetchJSON, UPSTREAM } = require("../lib/hn");

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

function response() {
  return Object.assign(new EventEmitter(), {
    headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    send(body) { this.body = body; },
  });
}

const request = (method, query) => Object.assign(new EventEmitter(), { method, query });

const routes = [
  ["stories", require("../api/stories"), {}],
  ["thread", require("../api/thread"), { id: "1" }],
  ["plain feed", require("../api/html/feed"), {}],
  ["plain item", require("../api/html/item"), { id: "1" }],
  ["classic feed", require("../api/html/feed"), { skin: "classic" }],
  ["classic item", require("../api/html/item"), { id: "1", skin: "classic" }],
];

function upstream(childFetch) {
  global.fetch = async (url, options) => {
    if (url.endsWith("stories.json")) return { ok: true, json: async () => [11, 12] };
    if (url.endsWith("/item/1.json")) {
      return { ok: true, json: async () => ({ id: 1, type: "story", kids: [11, 12] }) };
    }
    return childFetch(url, options);
  };
}

describe("API page failures", () => {
  for (const [name, handler, query] of routes) {
    it(`${name}: rejects a partial page and retries the same window`, async () => {
      let failed = true;
      upstream(async (url) => {
        if (failed && url.endsWith("/12.json")) throw new Error("Upstream unavailable");
        const id = Number(url.match(/\/(\d+)\.json$/)[1]);
        return { ok: true, json: async () => ({ id, type: "story", title: `Item ${id}`, text: `Comment ${id}` }) };
      });
      const first = response();
      await handler(request("GET", query), first);
      assert.equal(first.statusCode, 502);
      assert.doesNotMatch(first.body, /No comments yet|No stories on this page/);
      failed = false;
      const retry = response();
      await handler(request("GET", query), retry);
      assert.equal(retry.statusCode, 200);
      assert.match(retry.body, /11/);
      assert.match(retry.body, /12/);
    });

    it(`${name}: propagates a child timeout`, async () => {
      upstream(async () => { throw new DOMException("Timed out", "AbortError"); });
      const res = response();
      await handler(request("GET", query), res);
      assert.equal(res.statusCode, 504);
    });

    it(`${name}: permits genuinely missing items`, async () => {
      upstream(async () => ({ ok: true, json: async () => null }));
      const res = response();
      await handler(request("GET", query), res);
      assert.equal(res.statusCode, 200);
    });

    it(`${name}: rejects non-GET requests without fetching upstream`, async () => {
      global.fetch = () => { assert.fail("Must not fetch upstream"); };
      const res = response();
      await handler(request("POST", query), res);
      assert.equal(res.statusCode, 405);
      assert.equal(res.headers.allow, "GET");
    });
  }

  it("keeps AbortError when reading a response body is interrupted", async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => { throw new DOMException("Aborted", "AbortError"); },
    });
    await assert.rejects(fetchJSON("https://example.com"), { name: "AbortError" });
  });

  it("caps requested feed size and advances over deleted items", async () => {
    global.fetch = async (url) => ({
      ok: true,
      json: async () => url.endsWith("stories.json")
        ? Array.from({ length: 100 }, (_, i) => i + 10)
        : { id: Number(url.match(/\/(\d+)\.json$/)[1]), deleted: true },
    });
    const res = response();
    await routes[0][1]({ method: "GET", query: { limit: "9999" } }, res);
    const data = JSON.parse(res.body);
    assert.equal(data.limit, UPSTREAM.storiesMaxLimit);
    assert.equal(data.nextOffset, UPSTREAM.storiesMaxLimit);
    assert.equal(data.hasMore, true);
    assert.deepEqual(data.stories, []);
  });
});

it("caches only successful, standard first pages of public feeds", async () => {
  upstream(async (url) => ({
    ok: true,
    json: async () => ({ id: Number(url.match(/\/(\d+)\.json$/)[1]), type: "story" }),
  }));
  const queries = [
    [routes[0][1], { feed: "best", offset: "0", limit: "12" }, true],
    [routes[0][1], { feed: "top", offset: "12", limit: "30" }, false],
    [routes[0][1], { feed: "new", extra: "a" }, false],
    [routes[0][1], { feed: ["best", "top"] }, false],
    [routes[2][1], { feed: "new", theme: "light" }, true],
    [routes[4][1], { feed: "top", skin: "classic" }, true],
    [routes[2][1], { offset: "30" }, false],
    [routes[1][1], { id: "1" }, false],
  ];
  for (const [handler, query, shouldCache] of queries) {
    const res = response();
    await handler(request("GET", query), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["vercel-cdn-cache-control"], shouldCache ? "max-age=20, stale-while-revalidate=300" : undefined);
    assert.equal(res.headers["cache-control"], shouldCache ? "public, max-age=0, must-revalidate" : "no-store");
  }

  upstream(async () => { throw new Error("Unavailable"); });
  const res = response();
  await routes[0][1]({ method: "GET", query: { feed: "best", offset: "0", limit: "12" } }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["vercel-cdn-cache-control"], undefined);
});

it("plain and classic Retry links reload the failed feed page", async () => {
  const handler = require("../api/html/feed");
  for (const skin of ["plain", "classic"]) {
    const itemIds = [];
    let failed = true;
    global.fetch = async (url) => {
      if (url.endsWith("/newstories.json")) {
        if (failed) throw new Error("Feed unavailable");
        return { ok: true, json: async () => Array.from({ length: 40 }, (_, i) => i + 1) };
      }
      const id = Number(url.match(/\/item\/(\d+)\.json$/)[1]);
      itemIds.push(id);
      return { ok: true, json: async () => ({ id, type: "story", title: `Story ${id}` }) };
    };

    const res = response();
    await handler(request("GET", { skin, feed: "new", offset: "30", limit: "2", theme: "light" }), res);
    assert.equal(res.statusCode, 502);
    const href = res.body.match(/href="([^"]+)">Retry<\/a>/)[1].replaceAll("&amp;", "&");
    const retry = new URL(href, "https://hnx.example");
    assert.equal(retry.pathname, `/${skin}/new`);
    assert.equal(retry.searchParams.get("theme"), skin === "plain" ? "light" : null);

    failed = false;
    const recovered = response();
    await handler(request("GET", { ...Object.fromEntries(retry.searchParams), feed: "new", skin }), recovered);
    assert.equal(recovered.statusCode, 200);
    assert.deepEqual(itemIds, [31, 32]);
  }
});

it("redacts moderated comment bodies on direct item pages and in their API data", async () => {
  const item = require("../api/item");
  for (const flag of ["dead", "deleted", null]) {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ id: 11, type: "comment", text: "Original comment body", parent: 1, ...(flag ? { [flag]: true } : {}) }),
    });
    for (const skin of ["plain", "classic"]) {
      const res = response();
      await routes[3][1](request("GET", { id: "11", skin }), res);
      assert.equal(res.statusCode, 200);
      if (flag) {
        assert.ok(res.body.includes(`[${flag}]`));
        assert.doesNotMatch(res.body, /Original comment body/);
      } else assert.match(res.body, /Original comment body/);
    }
    for (const handler of [item, routes[1][1]]) {
      const res = response();
      await handler(request("GET", { id: "11" }), res);
      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.text, flag ? "" : "Original comment body");
      assert.equal(data.dead, flag === "dead");
      assert.equal(data.deleted, flag === "deleted");
      assert.equal(data.parent, 1);
    }
  }
});

it("streams the parent before requesting its comments and reports a later failure", async () => {
  const res = Object.assign(response(), {
    packets: [],
    write(line) {
      this.headersSent = true;
      this.packets.push(JSON.parse(line));
    },
    end(line) { this.write(line); },
  });
  let parentLookups = 0;
  global.fetch = async (url) => {
    if (url.endsWith("/item/1.json")) {
      parentLookups++;
      return { ok: true, json: async () => ({ id: 1, title: "Early title", kids: [11] }) };
    }
    assert.equal(res.packets[0]?.parent.title, "Early title");
    throw new Error("Comment unavailable");
  };
  await routes[1][1](request("GET", { id: "1", stream: "1" }), res);
  assert.equal(parentLookups, 1);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /application\/x-ndjson/);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.deepEqual(res.packets[1], { error: "Comment unavailable" });
});

it("cancels an upstream comment fetch when the client disconnects", async () => {
  const res = Object.assign(response(), { end() {} });
  let childStarted;
  const started = new Promise(resolve => { childStarted = resolve; });
  upstream(async (_url, { signal }) => {
    childStarted();
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const handling = routes[1][1](request("GET", { id: "1" }), res);
  await started;
  res.destroyed = true;
  res.emit("close");
  await handling;
  assert.equal(res.statusCode, undefined);
});
