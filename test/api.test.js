const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { fetchJSON, UPSTREAM } = require("../lib/hn");

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

function response() {
  return {
    headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    send(body) { this.body = body; },
  };
}

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
      await handler({ method: "GET", query }, first);
      assert.equal(first.statusCode, 502);
      assert.doesNotMatch(first.body, /No comments yet|No stories on this page/);
      failed = false;
      const retry = response();
      await handler({ method: "GET", query }, retry);
      assert.equal(retry.statusCode, 200);
      assert.match(retry.body, /11/);
      assert.match(retry.body, /12/);
    });

    it(`${name}: propagates a child timeout`, async () => {
      upstream(async () => { throw new DOMException("Timed out", "AbortError"); });
      const res = response();
      await handler({ method: "GET", query }, res);
      assert.equal(res.statusCode, 504);
    });

    it(`${name}: permits genuinely missing items`, async () => {
      upstream(async () => ({ ok: true, json: async () => null }));
      const res = response();
      await handler({ method: "GET", query }, res);
      assert.equal(res.statusCode, 200);
    });

    it(`${name}: rejects non-GET requests without fetching upstream`, async () => {
      global.fetch = () => { assert.fail("Must not fetch upstream"); };
      const res = response();
      await handler({ method: "POST", query }, res);
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
