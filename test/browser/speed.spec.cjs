const { test, expect } = require("@playwright/test");

// These cases intercept requests from the page. The offline suite exercises the real worker.
test.use({ serviceWorkers: "block" });

const rows = page => page.locator(".story-list .story");
const update = page => page.locator("[data-feed-update]");
const scrollY = page => page.evaluate(() => Math.round(window.scrollY));

/** Serves a feed whose first story IDs can change between requests. */
async function mockFeeds(page) {
  const feed = { requests: [], shift: 0, hold: null };
  await page.context().route("https://www.google.com/s2/favicons?**", route => route.abort());
  await page.route("**/api/stories?**", async route => {
    const params = new URL(route.request().url()).searchParams;
    const offset = Number(params.get("offset"));
    const limit = Number(params.get("limit"));
    const name = params.get("feed");
    feed.requests.push({ name, offset, fresh: params.get("fresh") });
    const shift = feed.shift;
    if (feed.hold) await feed.hold;
    await route.fulfill({ json: {
      stories: Array.from({ length: limit }, (_, index) => {
        const id = 100 + offset + index - shift;
        return { id, title: `${name} story ${id}`, url: "", time: 1 };
      }),
      nextOffset: offset + limit,
      hasMore: offset === 0,
      total: 42,
    } }).catch(() => {});
  });
  await page.route("**/api/thread?**", route => route.fulfill({ json: {
    id: 1, title: "Thread title", comments: [{ id: 5, by: "reader", text: "<p>A comment</p>" }],
    nextOffset: 1, total: 1, hasMore: false,
  } }));
  return feed;
}

async function openDeepFeed(page) {
  await page.goto("/");
  await expect(rows(page)).toHaveCount(12);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(rows(page)).toHaveCount(42);
  await page.evaluate(() => window.scrollTo(0, 900));
  await expect.poll(() => scrollY(page)).toBe(900);
}

async function returnAfter(page, ms) {
  await page.evaluate(elapsed => {
    let hidden = true;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event("visibilitychange"));
    hidden = false;
    const now = Date.now;
    Date.now = () => now() + elapsed;
    document.dispatchEvent(new Event("visibilitychange"));
    Date.now = now;
  }, ms);
}

test("going back keeps every row, the scroll position, and current header controls", async ({ page }) => {
  const feed = await mockFeeds(page);
  await openDeepFeed(page);
  const requests = feed.requests.length;

  for (let visit = 0; visit < 2; visit++) {
    if (visit) await page.goForward();
    else await page.evaluate(() => { location.hash = "/item/120"; });
    await expect(page.locator(".comment")).toBeVisible();
    await page.getByRole("button", { name: "Toggle theme" }).click();
    const theme = await page.locator("html").getAttribute("data-theme");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.goBack();
    await expect(rows(page)).toHaveCount(42);
    await expect.poll(() => scrollY(page)).toBe(900);
    await expect(page.getByRole("button", { name: "Toggle theme" })).toHaveAttribute("aria-pressed", String(theme === "light"));
  }
  expect(feed.requests).toHaveLength(requests);

  await page.keyboard.press("g");
  await page.keyboard.press("j");
  await expect(rows(page).nth(1)).toHaveClass(/is-selected/);
});

test("a discussion opened over a half-loaded list can still load more after going back", async ({ page }) => {
  await mockFeeds(page);
  await page.goto("/");
  await expect(rows(page)).toHaveCount(12);
  await page.evaluate(() => { location.hash = "/item/101"; });
  await expect(page.locator(".comment")).toBeVisible();
  await page.goBack();
  await expect(rows(page)).toHaveCount(12);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(rows(page)).toHaveCount(42);
});

test("a page request interrupted by a discussion is retried after going back", async ({ page }) => {
  const feed = await mockFeeds(page);
  await page.goto("/");
  await expect(rows(page)).toHaveCount(12);
  let release;
  feed.hold = new Promise(resolve => { release = resolve; });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => feed.requests.length).toBe(2);
  await page.evaluate(() => { location.hash = "/item/101"; });
  await expect(page.locator(".comment")).toBeVisible();
  release();
  feed.hold = null;
  await page.waitForTimeout(150);
  await expect(page.locator(".comment")).toBeVisible();
  await page.goBack();
  await expect(rows(page)).toHaveCount(42);
  const ids = await rows(page).evaluateAll(list => list.map(row => row.dataset.storyId));
  expect(new Set(ids).size).toBe(42);
});

test("returning to the tab offers new stories without moving the reader", async ({ page }) => {
  const feed = await mockFeeds(page);
  await openDeepFeed(page);
  await returnAfter(page, 61_000);
  await page.waitForTimeout(150);
  await expect(update(page)).toBeHidden();

  feed.shift = 3;
  await returnAfter(page, 61_000);
  await expect(update(page)).toHaveText("3 new stories");
  await expect(rows(page)).toHaveCount(42);
  expect(await scrollY(page)).toBe(900);
  await expect(update(page)).toBeInViewport();

  await update(page).click();
  await expect(rows(page).first()).toContainText("best story 97");
  await expect(rows(page)).toHaveCount(12);
  await expect(update(page)).toBeHidden();
  await expect.poll(() => scrollY(page)).toBe(0);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(rows(page)).toHaveCount(42);
});

test("returning at the top of the feed updates it in place", async ({ page }) => {
  const feed = await mockFeeds(page);
  await page.goto("/");
  await expect(rows(page)).toHaveCount(12);
  feed.shift = 2;
  await returnAfter(page, 61_000);
  await expect(rows(page).first()).toContainText("best story 98");
  await expect(rows(page)).toHaveCount(12);
  await expect(update(page)).toBeHidden();
});

test("a failed background check keeps the stories on screen", async ({ page }) => {
  await mockFeeds(page);
  await openDeepFeed(page);
  await page.route("**/api/stories?**", route => route.fulfill({ status: 502, json: { error: "Down" } }));
  await returnAfter(page, 61_000);
  await page.waitForTimeout(150);
  await expect(rows(page)).toHaveCount(42);
  expect(await scrollY(page)).toBe(900);
});

test("a recent feed shows before the network answers, then updates", async ({ page }) => {
  const feed = await mockFeeds(page);
  await page.goto("/");
  await expect(rows(page)).toHaveCount(12);
  await page.getByRole("tab", { name: "Top" }).click();
  await expect(rows(page).first()).toContainText("top story");

  let release;
  feed.shift = 1;
  feed.hold = new Promise(resolve => { release = resolve; });
  await page.getByRole("tab", { name: "Best" }).focus();
  await page.keyboard.press("Enter");
  await expect(rows(page)).toHaveCount(12);
  await expect(rows(page).first()).toContainText("best story 100");
  release();
  await expect(rows(page).first()).toContainText("best story 99");
  await expect(rows(page)).toHaveCount(12);

  // The same applies to reopening the app.
  feed.hold = new Promise(() => {});
  await page.reload();
  await expect(rows(page).first()).toContainText("best story 99");
});

test("an update never moves rows under a reader who is using them", async ({ page }) => {
  const feed = await mockFeeds(page);
  await page.goto("/");
  await expect(rows(page)).toHaveCount(12);
  let release;
  feed.shift = 1;
  feed.hold = new Promise(resolve => { release = resolve; });
  await page.reload();
  await expect(rows(page)).toHaveCount(12);
  await rows(page).nth(3).dispatchEvent("pointermove", { pointerType: "mouse" });
  release();
  await expect(update(page)).toHaveText("1 new story");
  await expect(rows(page).first()).toContainText("best story 100");
});

test("feeds stored over an hour ago wait for the network", async ({ page }) => {
  const feed = await mockFeeds(page);
  await page.goto("/");
  await expect(rows(page)).toHaveCount(12);
  await page.addInitScript(() => {
    const now = Date.now;
    Date.now = () => now() + 61 * 60 * 1000;
  });
  let release;
  feed.hold = new Promise(resolve => { release = resolve; });
  await page.reload();
  await page.waitForTimeout(300);
  await expect(rows(page)).toHaveCount(0);
  release();
  await expect(rows(page)).toHaveCount(12);
});

test("a discussion shows the feed title while its request is pending", async ({ page }) => {
  await mockFeeds(page);
  await page.goto("/");
  await expect(rows(page)).toHaveCount(12);
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  await page.route("**/api/thread?**", async route => {
    await hold;
    await route.fulfill({ json: { id: 104, title: "Current title", text: "<p>Story text</p>", comments: [], nextOffset: 0, total: 0 } });
  });
  await page.evaluate(() => { location.hash = "/item/104"; });
  const title = page.locator(".story-detail .story-title");
  await expect(title).toHaveText("best story 104");
  release();
  await expect(title).toHaveText("Current title");
  await expect(page.locator(".story-text")).toContainText("Story text");
});

test("a press starts the discussion, and a scroll cancels it", async ({ page }) => {
  await mockFeeds(page);
  await page.goto("/");
  await expect(rows(page)).toHaveCount(12);
  const threads = [];
  page.on("request", request => { if (request.url().includes("/api/thread?")) threads.push(request); });
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  await page.route("**/api/thread?**", async route => {
    await hold;
    await route.fulfill({ json: { id: 1, title: "T", comments: [{ id: 5, text: "Hi" }], nextOffset: 1, total: 1 } }).catch(() => {});
  });
  const touch = { pointerType: "touch", isPrimary: true, button: 0, pointerId: 2, bubbles: true };
  const links = page.locator("a.story-comments-link");

  const failed = page.waitForEvent("requestfailed", request => request.url().includes("id=100&"));
  await links.nth(0).dispatchEvent("pointerdown", touch);
  await expect.poll(() => threads.length).toBe(1);
  await links.nth(0).dispatchEvent("pointercancel", touch);
  await failed;

  await links.nth(1).dispatchEvent("pointerdown", touch);
  await links.nth(1).dispatchEvent("pointerup", touch);
  await links.nth(1).dispatchEvent("pointerout", touch);
  await links.nth(1).dispatchEvent("click");
  release();
  await expect(page.locator(".comment")).toBeVisible();
  expect(threads.filter(request => request.url().includes("id=101&"))).toHaveLength(1);
});

test("hovering replies loads them once, before the click", async ({ page }) => {
  const requests = [];
  page.on("request", request => {
    if (request.url().includes("/api/thread?id=500&")) requests.push(request.url());
  });
  await page.goto("/#/item/1");
  const button = page.locator('.comment[data-comment-id="500"] > .comment-header [data-action="load-replies"]');
  await button.dispatchEvent("pointerover", { pointerType: "mouse" });
  await expect.poll(() => requests.length).toBe(1);
  await button.dispatchEvent("click");
  const child = page.locator('.comment[data-comment-id="501"]');
  await expect(child).toBeVisible();
  // Loaded replies only toggle, so more hovering must not request them again.
  await button.dispatchEvent("pointerout", { pointerType: "mouse" });
  await button.dispatchEvent("pointerover", { pointerType: "mouse" });
  await page.waitForTimeout(300);
  expect(requests).toHaveLength(1);
});

test("pull to refresh bypasses stored and CDN copies", async ({ page, hasTouch }) => {
  test.skip(!hasTouch);
  await page.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: true }));
  const feed = await mockFeeds(page);
  await page.goto("/");
  await expect(rows(page)).toHaveCount(12);
  feed.shift = 1;
  for (const [type, y] of [["touchstart", 200], ["touchmove", 300], ["touchend", 300]]) {
    await page.locator("#feed-panel").evaluate((panel, data) => {
      const event = new Event(data.type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: data.type === "touchend" ? [] : [{ clientX: 100, clientY: data.y }] });
      panel.dispatchEvent(event);
    }, { type, y });
  }
  await expect(rows(page).first()).toContainText("best story 99");
  expect(feed.requests.at(-1).fresh).toBe("1");
});
