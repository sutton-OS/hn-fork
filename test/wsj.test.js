const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { WSJ_FEEDS, WSJ_LIMITS, articleURL, createWsjSource, mergeStories, parseFeed } = require("../lib/wsj");

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

const now = Math.floor(Date.now() / 1000);
const item = ({ title = "Headline", link = "https://www.wsj.com/tech/a-1?mod=rss", guid = link, age = 60, date } = {}) =>
  `<item><guid isPermaLink="false">${guid}</guid><title>${title}</title><description>Summary</description>
   <link>${link}</link><pubDate>${date ?? new Date((now - age) * 1000).toUTCString()}</pubDate>
   <media:content url="https://images.wsj.net/im-1"><media:title>Photo title</media:title></media:content></item>`;
const rss = (...items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Channel</title>${items.join("")}</channel></rss>`;
const story = (path, age, over = {}) => ({ id: -age, title: path, url: `https://www.wsj.com/${path}`, section: "Tech", time: now - age, ...over });

/** Serves one story per section. `feeds` overrides a section by path. */
function upstream(feeds = {}) {
  const calls = [];
  global.fetch = async (url) => {
    const path = url.split("/").at(-1);
    calls.push(path);
    const body = feeds[path] ?? rss(item({ title: path, link: `https://www.wsj.com/world/${path}` }));
    if (body instanceof Error) throw body;
    return typeof body === "number" ? { ok: false, status: body } : { ok: true, text: async () => body };
  };
  return calls;
}

function loadHandler() {
  for (const file of ["../lib/wsj-api", "../api/stories"]) delete require.cache[require.resolve(file)];
  return require("../api/stories");
}

async function get(handler, query = {}, method = "GET") {
  const res = {
    headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    send(body) { this.body = JSON.parse(body); },
  };
  await handler({ method, query: { feed: "wsj", ...query } }, res);
  return res;
}

describe("WSJ feed parsing", () => {
  it("reads headlines as text and strips tracking from links", () => {
    const [entry] = parseFeed(rss(item({ title: "Stocks &amp; Bonds&#x2019; &#8220;Rise&#8221; &amp;lt;b&amp;gt;" })), "Markets");
    assert.equal(entry.title, "Stocks & Bonds’ “Rise” &lt;b&gt;");
    assert.equal(entry.url, "https://www.wsj.com/tech/a-1");
    assert.equal(entry.domain, "wsj.com");
    assert.equal(entry.section, "Markets");
    assert.equal(entry.time, now - 60);
    assert.deepEqual(Object.keys(entry).sort(), ["domain", "id", "section", "time", "title", "url"]);
  });

  it("reads CDATA, drops newsletter notes, and labels politics stories by their link", () => {
    const [entry] = parseFeed(rss(item({
      title: "<![CDATA[A & B. Read more in today’s WSJ Politics newsletter:]]>", link: "https://www.wsj.com/politics/a-1",
    })), "U.S.");
    assert.equal(entry.title, "A & B.");
    assert.equal(entry.section, "Politics");
  });

  it("keeps IDs stable, safe, and apart from Hacker News items", () => {
    const ids = ["a", "b", "a"].map((guid) => parseFeed(rss(item({ guid })), "Tech")[0].id);
    assert.equal(ids[0], ids[2]);
    assert.notEqual(ids[0], ids[1]);
    for (const id of ids) assert.ok(Number.isSafeInteger(id) && id < 0);
  });

  it("leaves out opinion, lifestyle, shopping, and off-site links", () => {
    for (const link of [
      "https://www.wsj.com/opinion/a-1", "https://www.wsj.com/buyside/best", "https://www.wsj.com/lifestyle/a",
      "https://www.wsj.com/", "http://www.wsj.com/tech/a", "https://evilwsj.com/tech/a", "https://www.wsj.com.evil.example/a",
      "https://user@www.wsj.com/tech/a", "javascript:alert(1)", "",
    ]) assert.equal(articleURL(link), null, link);
    assert.equal(articleURL("https://www.wsj.com/tech/a?mod=x#y"), "https://www.wsj.com/tech/a");
  });

  it("skips incomplete entries and rejects anything that is not a feed", () => {
    assert.deepEqual(parseFeed(rss(item({ title: "" }), item({ date: "soon" }), "<item></item>"), "Tech"), []);
    for (const body of ["<html>Blocked</html>", rss(), "", null]) assert.throws(() => parseFeed(body, "Tech"), /WSJ returned/);
  });

  it("sorts newest first, drops old and duplicate stories, and clamps future dates", () => {
    const merged = mergeStories([
      [story("b", 300), story("future", -900, { id: -1 })],
      [story("a", 100), story("b", 300, { id: -9, section: "World" }), story("again", 5, { id: -300 })],
      [story("old", WSJ_LIMITS.maxAgeSeconds + 1)],
    ], now);
    assert.deepEqual(merged.map(({ title }) => title), ["future", "a", "b"]);
    assert.equal(merged[0].time, now);
    assert.equal(merged[2].section, "Tech");
  });

  it("prefers another feed's headline over the politics feed's social post", () => {
    const link = "https://www.wsj.com/politics/a-1";
    const lists = WSJ_FEEDS.filter(({ path }) => ["RSSUSnews", "socialpoliticsfeed"].includes(path))
      .map(({ path, section }) => parseFeed(rss(item({ title: path, link })), section));
    const merged = mergeStories(lists, now);
    assert.deepEqual(merged.map(({ title, section }) => [title, section]), [["RSSUSnews", "Politics"]]);
  });
});

describe("WSJ source", () => {
  it("shares one load between concurrent readers and reuses it", async (t) => {
    const calls = upstream();
    const getStories = createWsjSource();
    const [first, second] = await Promise.all([getStories(), getStories()]);
    assert.equal(first, second);
    assert.equal(calls.length, WSJ_FEEDS.length);
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + WSJ_LIMITS.freshReuseMs + 1000 });
    assert.equal(await getStories(), first);
    assert.equal(calls.length, WSJ_FEEDS.length);
    await getStories({ fresh: true });
    assert.equal(calls.length, WSJ_FEEDS.length * 2);
  });

  it("stands in a section's last good copy for an hour", async (t) => {
    const feeds = {};
    upstream(feeds);
    const getStories = createWsjSource();
    const titles = async () => (await getStories()).stories.map(({ title }) => title);
    assert.ok((await titles()).includes("RSSWSJD"));
    feeds.RSSWSJD = 503;
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + WSJ_LIMITS.reuseMs });
    assert.ok((await titles()).includes("RSSWSJD"));
    assert.equal((await getStories()).partial, true);
    t.mock.timers.tick(WSJ_LIMITS.fallbackMs);
    assert.ok(!(await titles()).includes("RSSWSJD"));
  });
});

describe("/api/stories?feed=wsj", () => {
  it("pages through every story", async () => {
    upstream({ RSSWSJD: rss(...Array.from({ length: 50 }, (_, i) => item({ link: `https://www.wsj.com/tech/${i}`, age: i + 1 }))) });
    const handler = loadHandler();
    const ids = new Set();
    let query = { offset: "0", limit: "12" };
    for (let pages = 0; query; pages += 1) {
      assert.ok(pages < 5);
      const { statusCode, body } = await get(handler, query);
      assert.equal(statusCode, 200);
      for (const entry of body.stories) ids.add(entry.id);
      query = body.hasMore ? { offset: String(body.nextOffset), limit: "30" } : null;
    }
    assert.equal(ids.size, 50 + WSJ_FEEDS.length - 1);
  });

  it("caches only complete responses for the URLs the app requests", async () => {
    upstream();
    const handler = loadHandler();
    for (const [query, cached] of [
      [{ offset: "0", limit: "12" }, true], [{ offset: "12", limit: "30" }, true], [{ offset: "42", limit: "30" }, true],
      [{ offset: "13", limit: "30" }, false], [{ offset: "012", limit: "30" }, false], [{ offset: "0", limit: "30" }, false],
      [{ offset: "0", limit: "12", fresh: "1" }, false], [{ offset: ["0", "0"], limit: "12" }, false], [{}, false],
      [{ feed: ["wsj", "wsj"], offset: "0", limit: "12" }, false], [{ offset: "0", limit: "12", other: "1" }, false],
    ]) {
      const res = await get(handler, query);
      assert.equal(res.statusCode, 200);
      assert.equal(Boolean(res.headers["vercel-cdn-cache-control"]), cached, JSON.stringify(query));
    }

    upstream({ RSSWSJD: 404 });
    const partial = await get(loadHandler(), { offset: "0", limit: "12" });
    assert.equal(partial.statusCode, 200);
    assert.equal(partial.headers["cache-control"], "no-store");
  });

  it("reports an outage or timeout, then recovers", async () => {
    const handler = loadHandler();
    for (const [failure, status] of [[403, 502], [new DOMException("Timed out", "TimeoutError"), 504]]) {
      upstream(Object.fromEntries(WSJ_FEEDS.map(({ path }) => [path, failure])));
      const res = await get(handler, { offset: "0", limit: "12" });
      assert.equal(res.statusCode, status);
      assert.equal(res.headers["cache-control"], "no-store");
    }
    upstream();
    assert.equal((await get(handler)).statusCode, 200);
  });

  it("leaves Hacker News feeds alone", async () => {
    const calls = [];
    global.fetch = async (url) => { calls.push(url); return { ok: true, json: async () => [] }; };
    const { body } = await get(loadHandler(), { feed: "top", offset: "0", limit: "12" });
    assert.equal(body.feed, "top");
    assert.deepEqual(calls, ["https://hacker-news.firebaseio.com/v0/topstories.json"]);
  });

  it("fits the 12 functions a Vercel Hobby deployment allows", () => {
    const files = fs.readdirSync(path.join(__dirname, "../api"), { recursive: true }).filter((file) => file.endsWith(".js"));
    assert.ok(files.length <= 12, `${files.length} functions`);
  });

  it("rejects non-GET requests without fetching upstream", async () => {
    const calls = upstream();
    const res = await get(loadHandler(), {}, "POST");
    assert.equal(res.statusCode, 405);
    assert.equal(calls.length, 0);
  });
});

it("stores only the WSJ pages the app requests", async () => {
  const { feedPageUrl, isFeedPage, normalizeTab } = await import("../public/modules/feed-cache.js");
  const stored = (path) => isFeedPage(new URL(path, "https://hnx.example"));
  assert.equal(feedPageUrl("wsj", 0, 12), "/api/stories?feed=wsj&offset=0&limit=12");
  assert.equal(feedPageUrl("top", 12, 30), "/api/stories?feed=top&offset=12&limit=30");
  for (const feed of ["wsj", "best", "top", "new"]) {
    assert.ok(stored(feedPageUrl(feed, 0, 12)));
    assert.ok(stored(feedPageUrl(feed, 42, 30)));
  }
  for (const path of ["/api/stories?feed=wsj&offset=0&limit=12&fresh=1", "/api/stories?feed=saved&offset=0&limit=12", "/api/stories?offset=0&limit=12", "/api/item?id=1"]) {
    assert.equal(stored(path), false, path);
  }
  assert.deepEqual(["wsj", "saved", "new", "other"].map(normalizeTab), ["wsj", "saved", "new", "best"]);
});
