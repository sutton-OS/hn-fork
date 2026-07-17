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
} = require("../lib/html");

describe("normalizeFeed", () => {
  it("accepts known feeds", () => {
    assert.equal(normalizeFeed("best"), "best");
    assert.equal(normalizeFeed("TOP"), "top");
    assert.equal(feedPath("new"), "newstories");
  });
  it("defaults unknown feeds", () => {
    assert.equal(normalizeFeed("nope"), "best");
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

describe("UPSTREAM caps", () => {
  it("keeps concurrency modest", () => {
    assert.ok(UPSTREAM.concurrency <= 16);
    assert.ok(UPSTREAM.storiesMaxLimit <= 80);
  });
});
