const { test, expect } = require("@playwright/test");

const publisher = "https://publisher.example";
const article = { title: "Inside the article", byline: "A. Writer", siteName: "Publisher",
  html: "<p>" + "Article paragraph. ".repeat(40) + "</p>", textLength: 720 };

async function feed(page, { decision = { embeddable: true, reason: "allowed" }, readable = true, paginate = false } = {}) {
  await page.context().route(publisher + "/**", route => route.fulfill({ contentType: "text/html", body: "<p>Live publisher page</p>" }));
  await page.route("https://www.google.com/s2/favicons?**", route => route.abort());
  const stories = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, title: "Headline " + (i + 1),
    url: publisher + (i === 0 ? "/file.pdf" : "/article/" + i) }));
  await page.route("**/api/stories?**", route => {
    const params = new URL(route.request().url()).searchParams;
    const offset = Number(params.get("offset"));
    const nextOffset = paginate ? Math.min(offset + Number(params.get("limit")), stories.length) : stories.length;
    return route.fulfill({ json: { stories: stories.slice(offset, nextOffset), nextOffset, hasMore: nextOffset < stories.length } });
  });
  await page.route("**/api/embeddable?**", route => route.fulfill({ json: decision }));
  await page.route("**/api/reader?**", route => route.fulfill(readable ? { json: article } : { status: 422, json: { error: "Too short" } }));
  await page.goto("/");
}

test("desktop headlines and direct files use native new tabs", async ({ page, hasTouch }) => {
  await feed(page);
  const popup = page.waitForEvent("popup");
  await page.getByRole("link", { name: hasTouch ? "Headline 1" : "Headline 2", exact: true }).click();
  await expect(await popup).toHaveURL(hasTouch ? /file.pdf$/ : /article\/1$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test.describe("touch preview", () => {
  test.beforeEach(async ({ hasTouch }) => { test.skip(!hasTouch); });

  test("site and reader modes, focus, scroll, and every dismissal path", async ({ page, context }) => {
    await feed(page);
    const link = page.getByRole("link", { name: "Headline 20", exact: true });
    await link.scrollIntoViewIfNeeded();
    const y = await page.evaluate(() => scrollY);
    expect(y).toBeGreaterThan(0);
    const initialHistory = await page.evaluate(() => history.length);
    const dialog = page.getByRole("dialog", { name: "Headline 20", exact: true });
    const headerLink = dialog.getByRole("link", { name: "Open in browser" });
    for (const method of ["close", "backdrop", "swipe", "back", "escape"]) {
      await link.tap();
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute("aria-modal", "true");
      await expect(dialog.getByRole("button", { name: "Close preview" })).toBeFocused();
      expect(context.pages()).toHaveLength(1);
      expect(await page.evaluate(() => history.length)).toBe(initialHistory + 1);
      const bodyStyle = await page.locator("body").evaluate(el => [getComputedStyle(el).position, getComputedStyle(el).overflow, el.getBoundingClientRect().top]);
      expect(bodyStyle).toEqual(["fixed", "hidden", -y]);
      await expect(page.frameLocator(".preview-content iframe").getByText("Live publisher page")).toBeVisible();
      if (method === "close") {
        for (const mode of ["Site", "Reader"]) {
          if (mode === "Reader") {
            await dialog.getByRole("button", { name: "Switch to Reader" }).click();
            await expect(dialog.getByRole("heading", { name: article.title })).toBeVisible();
          }
          const popup = page.waitForEvent("popup");
          await headerLink.click();
          const tab = await popup;
          await expect(tab).toHaveURL(publisher + "/article/19");
          await tab.close();
        }
        await dialog.getByRole("button", { name: "Switch to Site" }).click();
        await dialog.getByRole("button", { name: "Close preview" }).click();
      } else if (method === "backdrop") await page.touchscreen.tap(8, 8);
      else if (method === "back") await page.goBack();
      else if (method === "escape") await page.keyboard.press("Escape");
      else {
        await expect.poll(() => dialog.locator(".preview-panel").evaluate(el => el.getBoundingClientRect().bottom - innerHeight)).toBeCloseTo(0);
        const box = await dialog.locator("header").boundingBox();
        const touch = await context.newCDPSession(page);
        const swipe = (type, dy) => touch.send("Input.dispatchTouchEvent", { type,
          touchPoints: type === "touchEnd" ? [] : [{ x: 55, y: box.y + 15 + dy }] });
        await swipe("touchStart", 0);
        await swipe("touchMove", 70);
        await swipe("touchMove", 150);
        await swipe("touchEnd");
        await touch.detach();
      }
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(/\/$/);
      await expect(link).toBeFocused();
      await expect(page.locator(".story.is-selected .story-title")).toHaveText("Headline 20");
      expect(await page.evaluate(() => scrollY)).toBe(y);
      expect(await page.evaluate(() => history.state?.sheet)).toBeFalsy();
    }
  });

  test("frame denial, reduced motion, resizing and focus wrapping", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await feed(page, { decision: { embeddable: false, reason: "x-frame-options" } });
    const link = page.getByRole("link", { name: "Headline 2", exact: true });
    const probe = page.waitForRequest("**/api/embeddable?**");
    const reader = page.waitForRequest("**/api/reader?**");
    await link.tap();
    for (const pending of [probe, reader]) {
      expect([...new URL((await pending).url()).searchParams]).toEqual([["id", "2"]]);
    }
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("iframe")).toHaveCount(0);
    await expect(dialog.locator("h1")).toHaveText(article.title);
    await expect(dialog.locator(".preview-panel")).toHaveCSS("transition-duration", "0s");
    await dialog.getByRole("link", { name: "Open in browser" }).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.locator("article")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("link", { name: "Open in browser" })).toBeFocused();
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(dialog.locator(".preview-panel")).toHaveCSS("height", "382px");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    const tab = page.waitForEvent("popup");
    await link.click();
    await (await tab).close();
  });

  test("reload restores a preview beyond the first feed page", async ({ page }) => {
    const url = publisher + "/article/19";
    await page.route("**/api/item?id=20", route => route.fulfill({ json: { id: 20, title: "Headline 20", url } }));
    await feed(page, { paginate: true, decision: { embeddable: false, reason: "x-frame-options" } });
    await expect(page.locator(".story-list .story")).toHaveCount(12);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.getByRole("link", { name: "Headline 20", exact: true }).tap();

    const dialog = page.getByRole("dialog", { name: "Headline 20" });
    await expect(dialog.getByRole("heading", { name: article.title })).toBeVisible();
    const size = await page.evaluate(() => history.length);
    for (const legacy of [false, true]) {
      if (legacy) await page.evaluate(() => history.replaceState({ sheet: true, storyId: "20" }, ""));
      await page.reload();
      await expect(dialog.getByRole("heading", { name: article.title })).toBeVisible();
      await expect(dialog.getByRole("link", { name: "Open in browser" })).toHaveAttribute("href", url);
      await expect(page.locator(".story-list .story")).toHaveCount(12);
      await expect(page.locator('.story-list a[data-story-id="20"]')).toHaveCount(0);
      expect(await page.evaluate(() => history.length)).toBe(size);
    }
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => history.state?.sheet)).toBeFalsy();
  });

  test("a stalled iframe times out to Reader and cancels cleanly on close", async ({ page }) => {
    await feed(page);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route(publisher + "/article/1", async route => { await held; await route.abort().catch(() => {}); });
    try {
      await page.clock.install();
      const pending = page.waitForRequest(publisher + "/article/1");
      await page.getByRole("link", { name: "Headline 2", exact: true }).tap();
      await pending;
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("progressbar")).toHaveCount(1);
      await expect(dialog.getByRole("link", { name: "Open in browser" })).toHaveAttribute("href", publisher + "/article/1");
      await page.clock.fastForward(8100);
      await expect(dialog.getByRole("heading", { name: article.title })).toBeVisible();
      await expect(dialog.locator("iframe")).toHaveCount(0);
    } finally { release(); }
  });

  test("unreadable page keeps both external links and does not stack on rapid taps", async ({ page }) => {
    await feed(page, { decision: { embeddable: false, reason: "frame-ancestors" }, readable: false });
    const before = await page.evaluate(() => history.length);
    await page.getByRole("link", { name: "Headline 3", exact: true }).evaluate(a => { a.click(); a.click(); });
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("link", { name: "Open in browser" })).toHaveCount(2);
    expect(await page.evaluate(() => history.length)).toBe(before + 1);
    const tab = page.waitForEvent("popup");
    await dialog.getByRole("link", { name: "Open in browser" }).last().click();
    await expect(await tab).toHaveURL(publisher + "/article/2");
  });
});
