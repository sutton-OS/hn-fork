const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ context }) => {
  await context.route("https://www.google.com/s2/favicons?**", route => route.abort());
});

test("feed, discussion, back navigation, and native keyboard controls", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator(".story-list .story")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Retry loading stories" })).toBeHidden();
  const theme = page.getByRole("button", { name: "Toggle theme" });
  await theme.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(theme).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("tab", { name: "Best" }).focus();
  await page.keyboard.press("ArrowRight");
  const top = page.getByRole("tab", { name: "Top" });
  await expect(top).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(top).toHaveAttribute("aria-selected", "true");
  await expect(top).toBeFocused();
  const metadata = page.locator(".story-list .story-meta");
  const discussion = metadata.getByRole("link", { name: "comments on Test discussion" });
  await expect(discussion).toHaveText("comments");
  await expect(metadata).not.toContainText(/\b\d+ (?:pts|comments?)\b/);
  await expect(metadata.getByRole("link")).toHaveCount(1);
  await discussion.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/item\/1$/);
  await expect(page.locator(".comment[data-comment-id='2']")).toBeVisible();
  await expect(page.locator(".story-detail .story-text")).toContainText("Safe story text");
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  await expect(page.locator(".story-detail img, .story-detail script")).toHaveCount(0);
  const back = page.getByRole("link", { name: "back", exact: true });
  await back.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".story-list .story")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("only the current story has a selection highlight", async ({ page, hasTouch }) => {
  await page.route("**/api/stories?**", route => route.fulfill({ json: {
    stories: [{ id: 1, title: "First story" }, { id: 2, title: "Second story" }],
    nextOffset: 2, hasMore: false,
  } }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const rows = page.locator(".story-list .story");
  await expect(rows).toHaveCount(2);
  const secondSource = rows.nth(1).locator(".story-source");
  if (hasTouch) await secondSource.tap();
  else await secondSource.hover();

  // Check the visible accent bar, including any highlight caused by browser hover.
  const highlightedTitles = () => rows.evaluateAll(stories => stories
    .filter(row => getComputedStyle(row, "::before").backgroundColor !== "rgba(0, 0, 0, 0)")
    .map(row => row.querySelector(".story-title").textContent.trim()));
  await expect.poll(highlightedTitles).toEqual(["Second story"]);
  if (hasTouch) {
    await rows.first().locator(".story-source").tap();
    await expect.poll(highlightedTitles).toEqual(["First story"]);
    await secondSource.tap();
    await expect.poll(highlightedTitles).toEqual(["Second story"]);
  }
  await page.keyboard.press("g");
  await expect.poll(highlightedTitles).toEqual(["First story"]);
  await rows.nth(1).locator(".story-comments-link").focus();
  await expect.poll(highlightedTitles).toEqual(["Second story"]);
});

test("nested replies paginate once and deduplicate shifting pages", async ({ page }) => {
  const offsets = [];
  await page.route("**/api/thread?id=2&**", async route => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get("offset"));
    offsets.push(offset);
    // Deliberate overlap at page boundaries, as when HN changes ordering.
    const start = offset ? offset - 1 : 0;
    const comments = Array.from({ length: Math.min(40, 95 - start) }, (_, i) => ({ id: 1000 + start + i, by: "reader", text: `<p>Reply ${start + i}</p>`, replyCount: 0 }));
    await route.fulfill({ json: { id: 2, comments, nextOffset: offset + 40, total: 95, hasMore: offset + 40 < 95 } });
  });
  await page.goto("/#/item/1");
  const parent = page.locator('.comment[data-comment-id="2"]');
  const toggle = parent.locator(':scope > .comment-header [data-action="toggle-comment"]');
  const replies = parent.locator(':scope > .comment-header [data-action="load-replies"]');
  await toggle.click();
  await expect(replies).toHaveAttribute("aria-expanded", "false");
  await replies.click();
  await expect(parent.locator(".comment")).toHaveCount(40);
  await expect(parent.locator(".comment").first()).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-label", "Collapse comment");
  await expect(replies).toHaveAttribute("aria-expanded", "true");
  const more = parent.locator('[data-action="load-more-server"]');
  await more.click();
  await expect(parent.locator(".comment")).toHaveCount(60);
  // The header toggles visibility; it must never use a separate server cursor.
  await replies.click();
  await expect(parent).toHaveClass(/is-collapsed/);
  await expect(replies).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAttribute("aria-label", "Expand comment");
  await expect(parent.locator(".comment").first()).toBeHidden();
  await toggle.click();
  await expect(replies).toHaveAttribute("aria-expanded", "true");
  await expect(parent.locator(".comment").first()).toBeVisible();
  await toggle.click();
  await replies.click();
  await expect(parent).not.toHaveClass(/is-collapsed/);
  expect(offsets).toEqual([0, 40]);
  await parent.locator('[data-action="load-more-children"]').click();
  await expect(parent.locator(".comment")).toHaveCount(79);
  await more.click();
  await expect(parent.locator(".comment")).toHaveCount(95);
  expect(offsets).toEqual([0, 40, 80]);
  const ids = await parent.locator(".comment").evaluateAll(nodes => nodes.map(node => node.dataset.commentId));
  expect(new Set(ids).size).toBe(ids.length);
});

test("loading replies respects a more recent collapse", async ({ page }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route("**/api/thread?id=500&**", async route => {
    await pending;
    await route.continue();
  });
  await page.goto("/#/item/1");
  const parent = page.locator('.comment[data-comment-id="500"]');
  const toggle = parent.locator(':scope > .comment-header [data-action="toggle-comment"]');
  const replies = parent.locator(':scope > .comment-header [data-action="load-replies"]');
  const child = parent.locator('.comment[data-comment-id="501"]');
  try {
    await replies.click();
    await expect(replies).toBeDisabled();
    await toggle.click();
  } finally {
    release();
  }
  await expect(child).toHaveCount(1);
  await expect(child).toBeHidden();
  await expect(replies).toHaveAttribute("aria-expanded", "false");
  await replies.click();
  await expect(child).toBeVisible();
  await expect(replies).toHaveAttribute("aria-expanded", "true");
});

test("deep threads stop indenting and fit the viewport", async ({ page }) => {
  await page.goto("/#/item/1");
  for (let id = 500; id < 512; id++) {
    await page.locator(`.comment[data-comment-id="${id}"] > .comment-header [data-action="load-replies"]`).click();
    await expect(page.locator(`.comment[data-comment-id="${id + 1}"]`)).toBeVisible();
  }
  const geometry = await page.locator('.comment[data-comment-id="500"]').evaluate(root => {
    const x = el => el.getBoundingClientRect().left;
    return {
      atCap: x(root.querySelector('[data-depth="6"]')) - x(root),
      afterCap: x(root.querySelector('[data-depth="12"]')) - x(root),
      overflow: document.documentElement.scrollWidth > innerWidth,
      width: root.querySelector('[data-depth="12"] > .comment-text').getBoundingClientRect().width,
    };
  });
  expect(geometry.atCap).toBe(84);
  expect(geometry.afterCap - geometry.atCap).toBeLessThanOrEqual(2);
  expect(geometry.width).toBeGreaterThan(100);
  expect(geometry.overflow).toBe(false);
});

test("failed feed request retries without losing its page", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/stories?**", async route => {
    calls++;
    if (calls <= 2) await route.fulfill({ status: 502, json: { error: "Upstream unavailable" } });
    else await route.fulfill({ json: { stories: [{ id: 1, title: "Recovered story", time: 1 }], nextOffset: 12, hasMore: false } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Retry loading stories" }).click();
  await expect(page.locator(".story-list")).toContainText("Recovered story");
  await expect(page.getByRole("button", { name: "Retry loading stories" })).toBeHidden();
});

test("failed discussion offers an accessible retry", async ({ page }) => {
  let fail = true;
  const requests = [];
  await page.route("**/api/thread?id=1&**", async route => {
    requests.push(new URL(route.request().url()).searchParams.get("stream"));
    if (fail) await route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"parent":{"id":1,"title":"Already loaded"}}\n{"error":"Timed out"}\n',
    });
    else await route.continue();
  });
  await page.goto("/#/item/1");
  const retry = page.getByRole("button", { name: "Retry loading comments" });
  await expect(retry).toBeVisible();
  await expect(page.locator(".story-detail .story-title")).toHaveText("Already loaded");
  fail = false;
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('.comment[data-comment-id="2"]')).toBeVisible();
  await expect(page.locator(".story-detail .story-title")).toHaveText("Already loaded");
  expect(requests).toEqual(["1", null]);
});

test("plain and classic pages work with scripts disabled and enforce headers", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  for (const route of ["/plain", "/classic", "/plain/item/1", "/classic/item/1"]) {
    const response = await page.goto(baseURL + route);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-security-policy"]).toContain("script-src 'self'");
    expect(response.headers()["referrer-policy"]).toBe("no-referrer");
    await expect(page.locator("body")).toContainText(route.includes("item") ? "Many replies" : "Test discussion");
    await expect(page.locator("img, script")).toHaveCount(0);
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", /favicon-32x32/);
    if (route === "/plain") {
      const metadata = page.locator(".story-list .story-meta");
      const discussion = metadata.getByRole("link", { name: "comments on Test discussion" });
      await expect(discussion).toHaveText("comments");
      await expect(discussion).toHaveAttribute("href", "/plain/item/1?theme=dark");
      await expect(metadata).not.toContainText(/\b\d+ (?:pts|comments?)\b/);
    }
  }
  await context.close();
});

test("prefetched metadata cannot overwrite fresh details and revisits refresh comments", async ({ page }) => {
  let release;
  let requested;
  let calls = 0;
  const started = new Promise(resolve => { requested = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/api/item?id=1", route => route.fulfill({ json: { id: 1, title: "Fresh title", text: "", time: 1 } }));
  await page.route("**/api/thread?id=1&**", async route => {
    const revision = ++calls;
    if (revision === 1) { requested(); await gate; }
    await route.fulfill({ json: { id: 1, title: "Old prefetched title", comments: [{ id: 200 + revision, text: `Revision ${revision}`, replyCount: 0 }], nextOffset: 1, total: 1, hasMore: false } });
  });
  await page.goto("/");
  await page.locator("a.story-comments-link").dispatchEvent("pointerover", { pointerType: "mouse" });
  await started;
  await page.evaluate(() => { location.hash = "/item/1"; });
  await expect(page.locator(".story-detail .story-title")).toHaveText("Fresh title");
  release();
  await expect(page.locator(".comments")).toContainText("Revision 1");
  await expect(page.locator(".story-detail .story-title")).toHaveText("Fresh title");
  await page.evaluate(() => { location.hash = "/"; });
  await expect(page.locator(".story-list .story")).toHaveCount(1);
  await page.evaluate(() => { location.hash = "/item/1"; });
  await expect(page.locator(".comments")).toContainText("Revision 2");
  expect(calls).toBe(2);
});

test("cold feed waits for scrolling and defers discussion code", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  const offsets = [];
  const requests = [];
  page.on("request", request => requests.push(new URL(request.url()).pathname));
  await page.route("**/api/stories?**", route => {
    const params = new URL(route.request().url()).searchParams;
    const offset = Number(params.get("offset"));
    const limit = Number(params.get("limit"));
    offsets.push(offset);
    return route.fulfill({ json: {
      stories: Array.from({ length: limit }, (_, index) => ({
        id: offset + index + 1,
        title: "A typical news story long enough to wrap across more than one line of text",
      })),
      nextOffset: offset + limit,
      hasMore: offset === 0,
    } });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator(".story-list .story")).toHaveCount(12);
  expect(offsets).toEqual([0]);
  expect(requests.filter(path => /\/(?:comments|story|sanitize)\.js$|dompurify/.test(path))).toEqual([]);

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(page.locator(".story-list .story")).toHaveCount(42);
  expect(offsets).toEqual([0, 12]);
});

test("a direct discussion streams with no feed or separate item request", async ({ page }) => {
  const requests = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) requests.push(url);
  });
  await page.goto("/#/item/1");
  await expect(page.locator(".story-detail .story-title")).toHaveText("Test discussion");
  await expect(page.locator('.comment[data-comment-id="2"]')).toBeVisible();
  expect(requests.map(url => url.pathname)).toEqual(["/api/thread"]);
  expect(requests[0].searchParams.get("stream")).toBe("1");
});

test("long comments clamp independently and expand on demand", async ({ page }) => {
  await page.route("**/api/thread?id=1&**", route => route.fulfill({ json: {
    id: 1,
    title: "Test discussion",
    comments: [
      { id: 2, by: "reader", text: "<p>Short comment.</p>" },
      { id: 3, by: "reader", text: `<p>${"A long line with more to read. ".repeat(160)}</p>` },
    ],
  } }));
  await page.goto("/#/item/1");
  const long = page.locator('.comment[data-comment-id="3"]');
  const text = long.locator(".comment-text");
  await expect(text).toHaveClass(/is-clamped/);
  await expect(page.getByRole("button", { name: "Show more", exact: true })).toHaveCount(1);
  await long.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(text).not.toHaveClass(/is-clamped/);
});

test("hover waits for intent and leaving cancels the in-flight prefetch", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  const link = page.locator("a.story-comments-link");
  await expect(link).toBeVisible();
  const lookups = [];
  page.on("request", request => {
    if (request.url().includes("/api/thread?")) lookups.push(request);
  });
  await link.dispatchEvent("pointerover", { pointerType: "touch" });
  await page.clock.runFor(200);
  await link.dispatchEvent("pointerover", { pointerType: "mouse" });
  await link.dispatchEvent("pointerout", { pointerType: "mouse" });
  await page.clock.runFor(200);
  expect(lookups).toHaveLength(0);

  let release;
  const hold = new Promise(resolve => { release = resolve; });
  await page.route("**/api/thread?**", async route => {
    await hold;
    await route.abort().catch(() => {});
  });
  try {
    const pending = page.waitForRequest("**/api/thread?**");
    await link.dispatchEvent("pointerover", { pointerType: "mouse" });
    await page.clock.runFor(200);
    const request = await pending;
    const cancelled = page.waitForEvent("requestfailed", candidate => candidate === request);
    await link.dispatchEvent("pointerout", { pointerType: "mouse" });
    await cancelled;
    expect(lookups).toHaveLength(1);
  } finally {
    release();
  }
});

test("browser sanitizer removes malformed active markup and keeps safe links", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { sanitizeHNHTML } = await import("/modules/sanitize.js");
    const container = document.createElement("div");
    const inputs = [
      '<img src=/api/stories?limit=60 ',
      '<script>window.pwned=1</script><p onclick="bad()">Safe text</p>',
      '<svg><a href="javascript:alert(1)">bad</a></svg>',
      '<a href="jav&#x61;script:alert(1)">bad</a>',
      '<a href="https://example.com?a=1&amp;b=2" onclick="bad()">Safe link</a>',
    ];
    container.innerHTML = inputs.map(sanitizeHNHTML).join("");
    return {
      unsafeElements: container.querySelectorAll("img, script, svg, iframe, style").length,
      unsafeAttributes: container.querySelectorAll("[onclick], [onerror], [style]").length,
      hrefs: [...container.querySelectorAll("a[href]")].map(a => a.href),
      rels: [...container.querySelectorAll("a[href]")].map(a => a.rel),
      text: container.textContent,
    };
  });
  expect(result.unsafeElements).toBe(0);
  expect(result.unsafeAttributes).toBe(0);
  expect(result.hrefs).toEqual(["https://example.com/?a=1&b=2"]);
  expect(result.rels).toEqual(["noopener noreferrer"]);
  expect(result.text).toContain("Safe text");
});
