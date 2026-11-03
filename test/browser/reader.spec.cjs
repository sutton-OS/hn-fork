const { test, expect } = require("@playwright/test");

test("feed, discussion, back navigation, and native keyboard controls", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator(".story-list .story")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Retry loading stories" })).toBeHidden();
  const theme = page.getByRole("switch");
  await theme.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const top = page.getByRole("button", { name: "Feed: Top" });
  await top.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Feed: Top" })).toHaveAttribute("aria-pressed", "true");
  const discussion = page.locator("a.meta-time");
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
  const replies = parent.locator(':scope > .comment-header [data-action="load-replies"]');
  await replies.click();
  await expect(parent.locator(".comment")).toHaveCount(40);
  const more = parent.locator('[data-action="load-more-server"]');
  await more.click();
  await expect(parent.locator(".comment")).toHaveCount(60);
  // The header toggles visibility; it must never use a separate server cursor.
  await replies.click();
  await expect(parent).toHaveClass(/is-collapsed/);
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
  await page.route("**/api/thread?id=1&**", async route => {
    if (fail) await route.fulfill({ status: 504, json: { error: "Timed out" } });
    else await route.continue();
  });
  await page.goto("/#/item/1");
  const retry = page.getByRole("button", { name: "Retry loading comments" });
  await expect(retry).toBeVisible();
  fail = false;
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('.comment[data-comment-id="2"]')).toBeVisible();
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
  await page.evaluate(() => { void import("/modules/api.js").then(api => api.prefetchThread(1)); });
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
