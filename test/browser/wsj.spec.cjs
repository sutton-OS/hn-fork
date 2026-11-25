const { test, expect } = require("@playwright/test");

// These cases intercept requests from the page. The last one exercises the real worker.
const rows = page => page.locator(".story-list .story");
const tab = page => page.getByRole("tab", { name: "WSJ" });

test.beforeEach(async ({ context }) => {
  await context.route("https://www.google.com/s2/favicons?**", route => route.abort());
  await context.route("https://www.wsj.com/**", route => route.fulfill({ contentType: "text/html", body: "<title>WSJ</title>" }));
});

test.describe("WSJ tab", () => {
  test.use({ serviceWorkers: "block" });

  test("shows news headlines newest first, with a section instead of comments and bookmarks", async ({ page }) => {
    await page.goto("/");
    await tab(page).click();
    await expect(tab(page)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".story-list .story-title")).toHaveText(["Chip maker reports results", "Stocks & bonds rise"]);
    const row = rows(page).first();
    await expect(row.locator(".domain")).toHaveText("wsj.com");
    await expect(row.locator(".story-meta")).toContainText("Tech");
    await expect(row.locator(".story-title a")).toHaveAttribute("href", "https://www.wsj.com/tech/chip-results-1");
    await expect(rows(page).locator(".story-comments-link, [data-bookmark], [data-retry-saved]")).toHaveCount(0);
    await expect(rows(page).locator("img:not(.story-favicon)")).toHaveCount(0);

    await page.getByRole("tab", { name: "Best" }).click();
    await expect(rows(page).locator(".story-title")).toHaveText(["Test discussion"]);
    await expect(rows(page).locator("[data-bookmark]")).toHaveCount(1);
  });

  test("headlines open the publisher without a preview", async ({ page, hasTouch }) => {
    const previews = [];
    page.on("request", request => {
      if (/\/api\/(?:reader|embeddable|thread|item)/.test(request.url())) previews.push(request.url());
    });
    await page.goto("/");
    await tab(page).click();
    const link = rows(page).first().locator(".story-title a");
    const popup = page.waitForEvent("popup");
    if (hasTouch) await link.tap();
    else await link.click();
    expect((await popup).url()).toBe("https://www.wsj.com/tech/chip-results-1");
    await expect(page.locator(".preview-dialog")).toHaveCount(0);
    expect(previews).toEqual([]);
  });

  test("keyboard opens a headline, and the discussion key does nothing", async ({ page, hasTouch }) => {
    test.skip(hasTouch);
    await page.goto("/");
    await tab(page).click();
    await expect(rows(page)).toHaveCount(2);
    await tab(page).evaluate(element => element.blur());
    await page.keyboard.press("j");
    await page.keyboard.press("c");
    await expect(page).toHaveURL(/\/$/);
    await page.keyboard.press("j");
    const popup = page.waitForEvent("popup");
    await page.keyboard.press("Enter");
    expect((await popup).url()).toBe("https://www.wsj.com/finance/stocks-3");
  });

  test("loads more on scroll, updates in place, and recovers from a failure", async ({ page }) => {
    let shift = 0;
    let fail = true;
    const requests = [];
    await page.route("**/api/stories?feed=wsj&**", route => {
      const url = new URL(route.request().url());
      requests.push(url.search);
      if (fail) return route.fulfill({ status: 502, json: { error: "Wall Street Journal stories are unavailable." } });
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      return route.fulfill({ json: {
        stories: Array.from({ length: limit }, (_, index) => {
          const n = 100 + offset + index - shift;
          return { id: -n, title: `Headline ${n}`, url: `https://www.wsj.com/tech/${n}`, domain: "wsj.com", section: "Tech", time: 1 };
        }),
        nextOffset: offset + limit, hasMore: offset === 0, total: 42,
      } });
    });
    await page.goto("/");
    await tab(page).click();
    await expect(page.getByText("Wall Street Journal stories are unavailable.", { exact: false })).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "Retry loading stories" }).click();
    await expect(rows(page)).toHaveCount(12);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(rows(page)).toHaveCount(42);
    expect(requests.at(-1)).toBe("?feed=wsj&offset=12&limit=30");

    await page.getByRole("tab", { name: "Top" }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    shift = 1;
    await tab(page).click();
    await expect(rows(page).first()).toContainText("Headline");
    await expect(page.locator(".story-list").getByText("Headline 99", { exact: true })
      .or(page.getByRole("button", { name: "1 new story" }))).toBeVisible();
  });
});

test("the WSJ list is available offline after a visit", async ({ context, page }) => {
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await tab(page).click();
  await expect(rows(page)).toHaveCount(2);
  await context.setOffline(true);
  await page.reload();
  await tab(page).click();
  await expect(rows(page).first()).toContainText("Chip maker reports results");
  await rows(page).first().locator(".story-title a").click();
  await expect(page.getByText("You’re offline. Reconnect to open this link.")).toBeVisible();
});
