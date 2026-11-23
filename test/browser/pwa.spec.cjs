const { test, expect, devices } = require("@playwright/test");

// Keep the fixture routes deterministic in browsers that bypass interception once controlled.
test.use({ serviceWorkers: "block" });

async function mockFeeds(page) {
  const requests = [];
  await page.route("**/api/stories?**", route => {
    const params = new URL(route.request().url()).searchParams;
    const feed = params.get("feed");
    const offset = Number(params.get("offset"));
    const limit = Number(params.get("limit"));
    requests.push({ feed, offset });
    const revision = requests.filter(request => request.feed === feed && request.offset === 0).length;
    return route.fulfill({ json: {
      stories: Array.from({ length: limit }, (_, index) => ({
        id: offset + index + 1,
        title: `${feed} feed · load ${revision} · story ${offset + index + 1}`,
      })),
      nextOffset: offset + limit,
      hasMore: offset === 0,
    } });
  });
  return requests;
}

test.beforeEach(async ({ context }) => {
  await context.route("https://www.google.com/s2/favicons?**", route => route.abort());
});

test.describe("PWA installation", () => {
  test.use({ serviceWorkers: "allow" });

  test("manifest, branded icons and the offline root worker load", async ({ page, browserName }) => {
    const response = await page.goto("/");
    expect(response.headers()["content-security-policy"]).toContain("worker-src 'self'");
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(manifestHref).toBe("/manifest.webmanifest");
    const manifest = await (await page.request.get(manifestHref)).json();
    expect(manifest).toMatchObject({
      name: "HNx", short_name: "HNx", id: "/", start_url: "/", scope: "/",
      display: "standalone", orientation: "any", background_color: "#121212", theme_color: "#121212",
    });
    expect(manifest.icons.map(icon => [icon.sizes, icon.purpose ?? "any"])).toEqual([
      ["192x192", "any"], ["512x512", "any"], ["512x512", "maskable"],
    ]);
    const appleIcon = page.locator('link[rel="apple-touch-icon"]');
    await expect(appleIcon).toHaveAttribute("sizes", "180x180");
    for (const icon of [...manifest.icons, { src: await appleIcon.getAttribute("href"), sizes: "180x180" }]) {
      const size = await page.evaluate(async (src) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        return `${image.naturalWidth}x${image.naturalHeight}`;
      }, icon.src);
      expect(size).toBe(icon.sizes);
    }
    expect((await page.request.get("/sw.js")).headers()["cache-control"]).toBe("no-cache");
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toMatch(/\/sw\.js$/);
    expect((await page.evaluate(() => caches.keys())).sort()).toEqual(["hnx-feed-v1", "shell-v2"]);
    if (browserName === "chromium") {
      const devtools = await page.context().newCDPSession(page);
      expect((await devtools.send("Page.getAppManifest")).errors).toEqual([]);
      expect((await devtools.send("Page.getInstallabilityErrors")).installabilityErrors).toEqual([]);
    }
  });
});

test("layout fits 360, 768 and 1440px and the sticky header respects safe areas", async ({ page, browserName, hasTouch }) => {
  await mockFeeds(page);
  await page.setViewportSize({ width: 360, height: 640 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator(".story")).toHaveCount(12);

  if (hasTouch && browserName === "chromium") {
    const devtools = await page.context().newCDPSession(page);
    await devtools.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 47, bottom: 34, left: 42, right: 42 },
    });
    await expect(page.locator(".topbar")).toHaveCSS("padding-top", "59px");
    await expect(page.locator(".site-footer")).toHaveCSS("padding-left", "42px");
    await expect(page.locator(".site-footer")).toHaveCSS("padding-right", "42px");
    await expect(page.locator(".install-hint")).toHaveCSS("bottom", "46px");
    await expect(page.locator(".site-footer")).toHaveCSS("padding-bottom", "134px");
    await page.getByRole("button", { name: "Dismiss install hint" }).tap();
    await expect(page.locator(".site-footer")).toHaveCSS("padding-bottom", "62px");
    expect(await page.locator("body").evaluate(body => {
      const strip = getComputedStyle(body, "::before");
      return [strip.height, strip.backgroundColor];
    })).toEqual(["47px", "rgb(18, 18, 18)"]);
    const row = page.locator(".story").first();
    const { x, y, height } = await row.locator(".story-source").boundingBox();
    await devtools.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: x + 10, y: y + height / 2 }],
    });
    try {
      await expect(row).toHaveCSS("transform", "matrix(0.985, 0, 0, 0.985, 0, 0)");
    } finally {
      await devtools.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    await expect(row).toHaveCSS("transform", "none");
  }

  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 640 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.evaluate(() => window.scrollTo(0, 200));
  expect((await page.locator(".topbar").boundingBox()).y).toBe(0);

  if (hasTouch) {
    await expect(page.locator("html")).toHaveCSS("overscroll-behavior-y", "none");
    await expect(page.locator(".feed-option").first()).toHaveCSS("touch-action", "manipulation");
    await expect(page.locator(".feed-option").first()).toHaveCSS("-webkit-tap-highlight-color", "rgba(0, 0, 0, 0)");
    await expect(page.locator(".story-meta").first()).toHaveCSS("user-select", "none");
    await expect(page.locator(".story-title a").first()).not.toHaveCSS("user-select", "none");
    await expect(page.locator(".story").first()).toHaveCSS("transition-duration", "0s");
  }
});

test("install hint is limited to iOS Safari tabs and dismissal survives reload", async ({ page, hasTouch, browser, ignoreHTTPSErrors }) => {
  await page.goto("/");
  const hint = page.getByRole("complementary", { name: "Install HNx" });
  if (!hasTouch) {
    await expect(hint).toBeHidden();
    return;
  }

  await expect(hint).toContainText("Install: tap Share, then Add to Home Screen");
  await hint.getByRole("button", { name: "Dismiss install hint" }).tap();
  await expect(hint).toBeHidden();
  await page.reload();
  await expect(hint).toBeHidden();

  const device = devices["iPhone 13"];
  const other = await browser.newPage({
    ...device,
    ignoreHTTPSErrors,
    userAgent: device.userAgent.replace(/Version\/[\d.]+/, "CriOS/140.0"),
  });
  try {
    await other.route("https://www.google.com/s2/favicons?**", route => route.abort());
    await other.goto(page.url());
    await expect(other.locator(".install-hint")).toBeHidden();
  } finally {
    await other.close();
  }
});

test("an installed iOS feed refreshes its active tab after a deliberate pull at the top", async ({ page, hasTouch }) => {
  test.skip(!hasTouch);
  await page.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: true }));
  const requests = await mockFeeds(page);
  await page.goto("/");
  await expect(page.locator(".install-hint")).toBeHidden();
  await page.getByRole("tab", { name: "Top" }).tap();
  const panel = page.locator("#feed-panel");
  await expect(panel.locator(".story").first()).toContainText("top feed · load 1");
  const touch = (type, x = 100, y = 200) => panel.evaluate((element, eventData) => {
    const event = new Event(eventData.type, { bubbles: true, cancelable: true });
    const touches = eventData.type === "touchend" ? [] : [{ clientX: eventData.x, clientY: eventData.y }];
    Object.defineProperty(event, "touches", { value: touches });
    element.dispatchEvent(event);
  }, { type, x, y });

  await page.evaluate(() => window.scrollTo(0, 100));
  await touch("touchstart");
  await touch("touchmove", 100, 310);
  await expect(panel).not.toHaveClass(/is-pulling/);
  await touch("touchend");

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.body.classList.add("preview-open"));
  await touch("touchstart");
  await touch("touchmove", 100, 310);
  await expect(panel).not.toHaveClass(/is-pulling/);
  await touch("touchend");
  await page.evaluate(() => document.body.classList.remove("preview-open"));

  await touch("touchstart");
  await touch("touchmove", 100, 230);
  await expect(panel).toHaveClass(/is-pulling/);
  await expect(panel).not.toHaveClass(/is-pull-ready/);
  await touch("touchend");
  await expect(panel).not.toHaveClass(/is-pull-returning/);
  expect(requests.filter(request => request.offset === 0).map(request => request.feed)).toEqual(["best", "top"]);

  await touch("touchstart");
  await touch("touchmove", 100, 290);
  await expect(panel).toHaveClass(/is-pull-ready/);
  await touch("touchend");
  await expect(panel.locator(".story").first()).toContainText("top feed · load 2");
  expect(requests.filter(request => request.offset === 0).map(request => request.feed)).toEqual(["best", "top", "top"]);
});

test("touch tabs restore their own scroll positions past the first page", async ({ page, hasTouch }) => {
  test.skip(!hasTouch);
  const requests = await mockFeeds(page);
  await page.goto("/");
  const rows = page.locator(".story-list .story");
  await expect(rows).toHaveCount(12);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(rows).toHaveCount(42);

  const scrollTo = async y => {
    await page.evaluate(top => window.scrollTo(0, top), y);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(y);
  };
  const select = async name => {
    const { x, y, width, height } = await page.getByRole("tab", { name, exact: true }).boundingBox();
    await page.touchscreen.tap(x + width / 2, y + height / 2);
  };
  await scrollTo(1500);
  await select("Top");
  await expect(rows.first()).toContainText("top feed");
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await scrollTo(220);
  await select("Best");
  await expect(rows).toHaveCount(42);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(1500);
  await select("Top");
  await expect(rows.first()).toContainText("top feed");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(220);
  expect(requests.filter(request => request.feed === "best" && request.offset === 12)).toHaveLength(2);
});
