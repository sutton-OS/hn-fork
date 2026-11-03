const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeFeed,
  feedPath,
  parseItemId,
  leanComment,
  UPSTREAM,
} = require("../lib/hn");
const {
  sanitizeHNHTML,
  getSafeUrl,
  escapeHTML,
  withTheme,
  normalizeSkin,
  classicFeedPath,
  classicItemPath,
  classicStoryListItem,
} = require("../lib/html");

describe("normalizeFeed", () => {
  it("accepts known feeds", () => {
    assert.equal(normalizeFeed("best"), "best");
    assert.equal(normalizeFeed("TOP"), "top");
    assert.equal(feedPath("new"), "newstories");
  });
  it("defaults unknown feeds", () => {
    assert.equal(normalizeFeed("nope"), "best");
    for (const value of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      assert.equal(normalizeFeed(value), "best");
      assert.equal(feedPath(value), "beststories");
    }
  });
});

describe("parseItemId", () => {
  it("accepts plain digits", () => {
    assert.equal(parseItemId("42"), 42);
  });
  it("rejects scientific notation and junk", () => {
    assert.equal(parseItemId("1e21"), null);
    assert.equal(parseItemId("-3"), null);
    assert.equal(parseItemId("abc"), null);
  });
});

describe("leanComment", () => {
  it("counts replyCount from kids", () => {
    const c = leanComment({ id: 1, by: "a", time: 1, text: "hi", kids: [2, 3] });
    assert.equal(c.replyCount, 2);
    assert.equal(c.by, "a");
  });
});

describe("sanitizeHNHTML", () => {
  it("keeps safe links and strips scripts", () => {
    const out = sanitizeHNHTML(
      '<p>x<script>alert(1)</script><a href="https://example.com">ok</a></p>',
    );
    assert.match(out, /example\.com/);
    assert.doesNotMatch(out, /script/i);
  });
  it("decodes entity slashes in hrefs", () => {
    const out = sanitizeHNHTML(
      '<a href="https:&#x2F;&#x2F;example.com&#x2F;a">t</a>',
    );
    assert.match(out, /href="https:\/\/example\.com\/a"/);
  });
  it("drops javascript urls", () => {
    const out = sanitizeHNHTML('<a href="javascript:alert(1)">x</a>');
    assert.doesNotMatch(out, /javascript:/i);
  });
  it("discards incomplete tags before surrounding markup is appended", () => {
    for (const input of [
      '<img src=/api/stories?limit=60 ',
      '<a href="javascript:alert(1)" ',
      '<script src="/app.js"',
    ]) {
      assert.equal(sanitizeHNHTML(input), "");
    }
  });
  it("removes active content and attributes while preserving readable text", () => {
    const out = sanitizeHNHTML('<p onclick="alert(1)" style="color:red">hello<img src="/api/item?id=1"><svg><a href="javascript:alert(1)">bad</a></svg></p>');
    assert.match(out, /hello/);
    assert.doesNotMatch(out, /onclick|style=|<img|<svg|javascript:/i);
  });
  it("normalizes entity-encoded URLs and strips dangerous or relative links", () => {
    const out = sanitizeHNHTML('<a href="https:&#47;&#47;example.com/?a=1&amp;b=2" onclick="bad()">safe</a>');
    assert.match(out, /href="https:\/\/example.com\/\?a=1&amp;b=2"/);
    assert.match(out, /rel="noopener noreferrer"/);
    for (const url of ["jav&#x61;script:alert(1)", "data:text/html,bad", "//evil.example", "/api/stories"]) {
      assert.doesNotMatch(sanitizeHNHTML(`<a href="${url}">text</a>`), /href=/);
    }
  });
  it("preserves paragraphs, lists, and code and safely escapes literal markup", () => {
    assert.equal(sanitizeHNHTML('<p>A &amp; B</p><pre><code>&lt;img&gt;</code></pre><ul><li>one</li></ul>'), '<p>A &amp; B</p><pre><code>&lt;img&gt;</code></pre><ul><li>one</li></ul>');
  });
});

describe("escapeHTML", () => {
  it("escapes quotes for attributes", () => {
    assert.equal(escapeHTML('a"b'), "a&quot;b");
  });
});

describe("getSafeUrl", () => {
  it("allows http(s) only", () => {
    assert.ok(getSafeUrl("https://x.com"));
    assert.equal(getSafeUrl("javascript:alert(1)"), null);
  });
});

describe("withTheme", () => {
  it("appends theme query", () => {
    assert.equal(withTheme("/plain/best", "light"), "/plain/best?theme=light");
  });
});

describe("classic skin", () => {
  it("normalizes skin", () => {
    assert.equal(normalizeSkin("classic"), "classic");
    assert.equal(normalizeSkin("plain"), "plain");
    assert.equal(normalizeSkin(""), "plain");
  });
  it("builds classic paths without theme", () => {
    assert.equal(classicFeedPath("best"), "/classic/best");
    assert.equal(classicFeedPath("top", { offset: 30 }), "/classic/top?offset=30");
    assert.equal(classicItemPath(42), "/classic/item/42");
    assert.equal(classicItemPath(42, { offset: 40 }), "/classic/item/42?offset=40");
  });
  it("renders a bare list item with blue-link-friendly markup", () => {
    const html = classicStoryListItem({
      id: 1,
      title: "Hello",
      url: "https://example.com",
      domain: "example.com",
      time: Math.floor(Date.now() / 1000) - 120,
    });
    assert.match(html, /href="https:\/\/example\.com\/?"/);
    assert.match(html, /href="\/classic\/item\/1"/);
    assert.match(html, /comments/);
  });
});

describe("UPSTREAM caps", () => {
  it("keeps concurrency modest", () => {
    assert.ok(UPSTREAM.concurrency <= 16);
    assert.ok(UPSTREAM.storiesMaxLimit <= 80);
  });
});
