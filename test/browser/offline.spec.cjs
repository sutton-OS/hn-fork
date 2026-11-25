const { chromium, test, expect } = require("@playwright/test");

const article = "Field notes";
const brief = "A short article";
const row = (page, title) => page.locator(".story-list .story").filter({ has: page.getByRole("link", { name: title, exact: true }) });
const bookmark = (page, title) => row(page, title).getByRole("button", { name: "Save for later" });
const savedTab = (page) => page.getByRole("tab", { name: /^Saved/ });
const reader = (page) => page.getByRole("dialog");
const banner = (page) => page.getByText("Offline. Showing saved and recently loaded stories");

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "hnx-offline-fixture", value: "1", url: baseURL }]);
  await context.route("https://www.google.com/s2/favicons?**", (route) => route.abort());
});

async function workerControls(page) {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

async function openReadyArticle(page) {
  await row(page, article).getByRole("link", { name: article, exact: true }).click();
  await expect(reader(page).getByText("Saved offline", { exact: false })).toBeVisible();
}

test("bookmark controls, Undo, fallback, storage estimate, removal and clear", async ({ page }) => {
  await page.goto("/");
  const control = bookmark(page, article);
  await control.focus();
  await page.keyboard.press("Space");
  await expect(control).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const target = await control.boundingBox();
  expect(target.width).toBeGreaterThanOrEqual(44);
  expect(target.height).toBeGreaterThanOrEqual(44);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(control).toHaveAttribute("aria-pressed", "false");

  await savedTab(page).click();
  await expect(page.getByText("Nothing saved yet. Tap the bookmark on any story.")).toBeVisible();
  await page.getByRole("tab", { name: "Best" }).click();
  await control.click();
  await expect(row(page, article).getByText("Saving offline copy…")).toBeHidden();
  await bookmark(page, brief).click();

  await savedTab(page).click();
  await expect(savedTab(page)).toHaveText("Saved 2");
  await expect(page.locator(".story-list .story-title")).toHaveText([brief, article]);
  await expect(page.locator("[data-saved-size]")).toHaveText(/2 saved, ~\d+\.\d MB/);
  const retry = row(page, brief).getByRole("button", { name: "No offline copy, retry" });
  await expect(retry).toBeVisible();
  const requested = page.waitForRequest("**/api/reader?id=21&offline=1");
  await retry.click();
  await requested;
  await expect(retry).toBeVisible();
  await row(page, brief).getByRole("link", { name: brief, exact: true }).click();
  await expect(reader(page).getByRole("link", { name: "Open in browser" })).toHaveAttribute("href", "https://publisher.example/short");
  await page.keyboard.press("Escape");

  await openReadyArticle(page);
  const sheetSave = reader(page).getByRole("button", { name: "Save for later" });
  await expect(sheetSave).toHaveAttribute("aria-pressed", "true");
  await sheetSave.click();
  await expect(sheetSave).toHaveAttribute("aria-pressed", "false");
  await sheetSave.click();
  await expect(sheetSave).toHaveAttribute("aria-pressed", "true");
  await reader(page).getByRole("button", { name: "Undo" }).click();
  await expect(sheetSave).toHaveAttribute("aria-pressed", "false");
  await reader(page).getByRole("button", { name: "Close" }).click();
  await expect(savedTab(page)).toHaveText("Saved 1");

  await row(page, brief).locator("summary").click();
  await row(page, brief).getByRole("button", { name: "Remove" }).click();
  await expect(savedTab(page)).toHaveText("Saved 0");

  await page.getByRole("tab", { name: "Best" }).click();
  await control.click();
  await savedTab(page).click();
  await openReadyArticle(page);
  await reader(page).getByRole("button", { name: "Close" }).click();
  const clear = page.getByRole("button", { name: "Clear all saved" });
  page.once("dialog", (dialog) => dialog.dismiss());
  await clear.click();
  await expect(savedTab(page)).toHaveText("Saved 1");
  page.once("dialog", (dialog) => dialog.accept());
  await clear.click();
  await expect(savedTab(page)).toHaveText("Saved 0");
  await page.reload();
  await savedTab(page).click();
  await expect(page.getByText("Nothing saved yet.", { exact: false })).toBeVisible();
  const images = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("hnx-saved");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return new Promise((resolve) => {
      const req = db.transaction("images").objectStore("images").count();
      req.onsuccess = () => { db.close(); resolve(req.result); };
    });
  });
  expect(images).toBe(0);
});

test("a new app window loads stored feeds and a readable saved article with the network off", async ({ context, page }) => {
  await context.addInitScript(() => {
    const revoke = URL.revokeObjectURL;
    window.revokedImages = [];
    URL.revokeObjectURL = (url) => { window.revokedImages.push(url); revoke(url); };
  });
  await page.goto("/");
  await expect(row(page, article)).toBeVisible();
  await workerControls(page);
  await page.getByRole("tab", { name: "Top" }).click();
  await expect(page.locator(".story-list .story-title")).toHaveText([brief, article]);
  await page.getByRole("tab", { name: "New" }).click();
  await expect(page.locator(".story-list .story-title")).toHaveText([article]);
  await bookmark(page, article).click();
  await savedTab(page).click();
  await openReadyArticle(page);
  await reader(page).getByRole("button", { name: "Close" }).click();

  await context.setOffline(true);
  await expect(banner(page)).toBeVisible();
  await page.close();
  const offline = await context.newPage();
  await offline.goto("/");
  await expect(banner(offline)).toBeVisible();
  await expect(page.isClosed()).toBe(true);
  await expect(offline.locator(".story-list .story-title")).toHaveText([article, brief]);
  await offline.getByRole("tab", { name: "Top" }).click();
  await expect(offline.locator(".story-list .story-title")).toHaveText([brief, article]);
  await offline.getByRole("tab", { name: "New" }).click();
  await expect(offline.locator(".story-list .story-title")).toHaveText([article]);
  await savedTab(offline).click();
  await openReadyArticle(offline);

  const sheet = reader(offline);
  await expect(sheet.getByText("Field research for the offline reader.", { exact: false })).toBeVisible();
  const photo = sheet.getByRole("img", { name: "Field photo" });
  await expect(photo).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => photo.evaluate((node) => node.naturalWidth)).toBe(32);
  await expect(sheet.getByRole("img", { name: "Missing photo" })).toHaveCount(0);
  const src = await photo.getAttribute("src");
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect.poll(() => offline.evaluate(() => window.revokedImages)).toContain(src);
  await expect(row(offline, article).getByRole("link", { name: article, exact: true })).toBeFocused();

  await offline.getByRole("tab", { name: "Best" }).click();
  await row(offline, brief).getByRole("link", { name: brief, exact: true }).click();
  await expect(offline.getByText("You’re offline. Reconnect to open this link.")).toBeVisible();
  await context.setOffline(false);
  await expect(banner(offline)).toBeHidden();
});

test("quota failure leaves a retryable bookmark across reload", async ({ page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (item, ...args) {
      if (this.name === "saved" && item.status === "ready") {
        throw new DOMException("Test quota exceeded", "QuotaExceededError");
      }
      return put.call(this, item, ...args);
    };
  });
  await page.goto("/");
  await bookmark(page, article).click();
  await expect(page.getByText("Storage is full. The bookmark is kept without an offline copy.")).toBeVisible();
  await page.reload();
  await savedTab(page).click();
  await expect(savedTab(page)).toHaveText("Saved 1");
  await expect(row(page, article).getByRole("button", { name: "No offline copy, retry" })).toBeVisible();
});

test("saved data survives restarting Chromium with the same profile", async ({ baseURL }, testInfo) => {
  const profile = testInfo.outputPath("offline-profile");
  let context = await chromium.launchPersistentContext(profile, { baseURL });
  try {
    await context.addCookies([{ name: "hnx-offline-fixture", value: "1", url: baseURL }]);
    const page = await context.newPage();
    await page.goto("/");
    await workerControls(page);
    await bookmark(page, article).click();
    await savedTab(page).click();
    await openReadyArticle(page);
  } finally {
    await context.close();
  }

  context = await chromium.launchPersistentContext(profile, { baseURL, offline: true });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(banner(page)).toBeVisible();
    await savedTab(page).click();
    await openReadyArticle(page);
  } finally {
    await context.close();
  }
});

test("saving over the soft cap asks first and keeps every existing bookmark", async ({ page }) => {
  await page.goto("/");
  await expect(row(page, article)).toBeVisible();
  await page.evaluate(async () => {
    const { createSavedStore } = await import("/modules/saved-store.js");
    const store = createSavedStore();
    await Promise.all(Array.from({ length: 200 }, (_, index) => store.put({
      id: 1000 + index, title: `Previously saved ${index}`, domain: "example.com",
      status: "no-offline-copy", savedAt: index, hnTime: 1, saveToken: `saved-${index}`,
    })));
  });
  await page.reload();
  await expect(savedTab(page)).toHaveText("Saved 200");
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("200 saved stories");
    return dialog.dismiss();
  });
  await bookmark(page, article).click();
  await expect(savedTab(page)).toHaveText("Saved 200");
  page.once("dialog", (dialog) => dialog.accept());
  await bookmark(page, article).click();
  await expect(savedTab(page)).toHaveText("Saved 201");
  await savedTab(page).click();
  await expect(page.locator(".story-list .story")).toHaveCount(201);
});

test("bookmarks remain usable when IndexedDB cannot be opened", async ({ page }) => {
  await page.addInitScript(() => {
    IDBFactory.prototype.open = () => { throw new DOMException("Blocked for this test", "SecurityError"); };
    const persist = () => { window.persistCalls = (window.persistCalls || 0) + 1; return Promise.resolve(false); };
    navigator.storage.persist = persist;
  });
  await page.goto("/");
  await bookmark(page, article).click();
  await expect(page.getByText("Bookmark saved. Offline article storage is unavailable.")).toBeVisible();
  await bookmark(page, brief).click();
  await expect(savedTab(page)).toHaveText("Saved 2");
  expect(await page.evaluate(() => window.persistCalls)).toBe(1);
  await page.reload();
  await savedTab(page).click();
  await expect(savedTab(page)).toHaveText("Saved 2");
  await expect(row(page, article).getByRole("button", { name: "No offline copy, retry" })).toBeVisible();
});

test("a service worker update replaces old shell caches and preserves loaded feeds", async ({ context, page }) => {
  const { createTestServer } = require("./server.cjs");
  let newer = false;
  const server = createTestServer({ isNewShell: () => newer });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await context.addCookies([{ name: "hnx-offline-fixture", value: "1", url }]);
    await page.goto(url);
    await workerControls(page);
    await expect(row(page, article)).toBeVisible();
    await page.evaluate(async () => {
      await caches.open("hnx-static-v16");
      await caches.open("hnx-api-v4");
    });
    newer = true;
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await expect.poll(() => page.evaluate(() => caches.keys())).toEqual(["hnx-feed-v1", "shell-v10"]);
    await page.reload();
    await expect(page).toHaveTitle("HNx updated");
    await context.setOffline(true);
    await page.reload();
    await expect(page).toHaveTitle("HNx updated");
    await expect(row(page, article)).toBeVisible();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
