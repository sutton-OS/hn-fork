const { createECDH, createHash, randomBytes, randomUUID } = require("node:crypto");
const { expect, test } = require("@playwright/test");

const key = createECDH("prime256v1");
key.generateKeys();
const publicKey = key.getPublicKey().toString("base64url");
const firstEndpoint = "https://fcm.googleapis.com/fcm/send/test-device";
const nextEndpoint = "https://web.push.apple.com/rotated-device";

async function fakeSubscription(context, standalone) {
  await context.addInitScript(({ standalone, firstEndpoint, publicKey, auth }) => {
    if (standalone !== undefined) Object.defineProperty(navigator, "standalone", { value: standalone });
    window.permissionPrompts = 0;
    Object.defineProperty(Notification, "permission", { get: () => localStorage.getItem("test-permission") || "default" });
    Notification.requestPermission = async () => {
      window.permissionPrompts++;
      localStorage.setItem("test-permission", "granted");
      return "granted";
    };
    const subscription = endpoint => ({
      endpoint,
      toJSON: () => ({ endpoint, keys: { p256dh: publicKey, auth } }),
      unsubscribe: async () => { localStorage.removeItem("test-endpoint"); return true; },
    });
    PushManager.prototype.getSubscription = async () => {
      const endpoint = localStorage.getItem("test-endpoint");
      return endpoint ? subscription(endpoint) : null;
    };
    PushManager.prototype.permissionState = async () => Notification.permission;
    PushManager.prototype.subscribe = async options => {
      if (!options.userVisibleOnly || options.applicationServerKey.length !== 65) throw new Error("Invalid push options");
      localStorage.setItem("test-endpoint", firstEndpoint);
      return subscription(firstEndpoint);
    };
  }, { standalone, firstEndpoint, publicKey, auth: randomBytes(16).toString("base64url") });
}

async function mockAlerts(context) {
  let saved;
  const registrations = [];
  const tests = [];
  await context.route(/\/api\/(subscribe|rules|unsubscribe|test)$/, route => {
    const req = route.request();
    const action = new URL(req.url()).pathname.slice(5);
    const reply = (json, status = 200) => route.fulfill({ status, json });
    if (req.method() === "GET") return reply({ publicKey });
    const body = req.postDataJSON();
    if (action === "subscribe") {
      registrations.push(body);
      const id = createHash("sha256").update(body.subscription.endpoint).digest("hex");
      saved = { id, rules: saved?.rules ?? body.rules, revision: saved?.revision ?? randomUUID() };
      return reply(saved);
    }
    if (action === "rules") {
      if (body.revision !== saved?.revision) return reply({ error: "Stale revision" }, 409);
      saved = { ...saved, rules: body.rules, revision: randomUUID() };
      return reply(saved);
    }
    if (action === "test") {
      tests.push(body.id);
      return reply({ sent: true });
    }
    saved = undefined;
    return reply({ deleted: true });
  });
  return { registrations, tests, get: () => saved };
}

test.beforeEach(async ({ context }) => {
  await context.route("https://www.google.com/s2/favicons?**", route => route.abort());
});

test("Enable is the only prompt and rule CRUD survives reload and endpoint rotation", async ({ context, page, hasTouch }) => {
  await fakeSubscription(context, hasTouch ? true : undefined);
  const backend = await mockAlerts(context);
  await page.goto("/");
  expect(await page.evaluate(() => window.permissionPrompts)).toBe(0);
  const bell = page.getByRole("button", { name: "Alerts", exact: true });
  await bell.click();
  const alerts = page.getByRole("dialog", { name: "Alerts" });
  await expect(alerts.getByText("Permission: Not requested · Subscribed: No")).toBeVisible();
  expect(await page.evaluate(() => window.permissionPrompts)).toBe(0);
  const registration = page.waitForRequest(req => req.method() === "POST" && req.url().endsWith("/api/subscribe"));
  await alerts.getByRole("button", { name: "Enable notifications" }).click();
  expect((await (await registration).allHeaders()).origin).toBe(new URL(page.url()).origin);
  await expect(alerts.getByText("Permission: Granted · Subscribed: Yes")).toBeVisible();
  expect(await page.evaluate(() => window.permissionPrompts)).toBe(1);

  await alerts.getByRole("button", { name: "Add rule" }).click();
  const points = alerts.getByRole("spinbutton", { name: "Minimum points" });
  await expect(points).toHaveValue("100");
  await alerts.getByRole("button", { name: "Increase minimum points" }).click();
  await expect(points).toHaveValue("110");
  await alerts.getByRole("button", { name: "Decrease minimum points" }).click();
  await alerts.getByLabel("Keywords").fill('swift, privacy, "open source"');
  await alerts.getByLabel("Domain").fill("GitHub.com");
  await alerts.getByLabel("Only if on the front page (top 30)").check();
  await alerts.getByRole("button", { name: "Save rule" }).click();
  await expect(alerts.getByText("100+ points · github.com · Top 30")).toBeVisible();
  await alerts.getByRole("button", { name: /^Edit rule/ }).click();
  await points.fill("150");
  await alerts.getByRole("button", { name: "Save rule" }).click();
  await expect(alerts.getByText("150+ points · github.com · Top 30")).toBeVisible();
  await alerts.getByRole("button", { name: /^Disable rule/ }).click();
  await expect(alerts.getByRole("button", { name: /^Enable rule/ })).toBeEnabled();
  expect(backend.get().rules[0].enabled).toBe(false);

  const previousId = backend.get().id;
  await page.evaluate(endpoint => localStorage.setItem("test-endpoint", endpoint), nextEndpoint);
  await page.reload();
  await bell.click();
  await expect(alerts.getByText("Permission: Granted · Subscribed: Yes")).toBeVisible();
  expect(await page.evaluate(() => window.permissionPrompts)).toBe(0);
  expect(backend.registrations.find(body => body.previous)?.previous.id).toBe(previousId);
  await expect(alerts.getByText("150+ points · github.com · Top 30")).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem("test-permission", "denied");
    window.dispatchEvent(new Event("focus"));
  });
  await expect(alerts.getByText("Permission: Denied · Subscribed: No")).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem("test-permission", "granted");
    window.dispatchEvent(new Event("focus"));
  });
  await expect(alerts.getByText("Permission: Granted · Subscribed: Yes")).toBeVisible();
  await alerts.getByRole("button", { name: "Send test notification" }).click();
  await expect(alerts.getByText("Test notification sent.")).toBeVisible();
  expect(backend.tests).toEqual([backend.get().id]);

  await alerts.getByRole("button", { name: /^Delete rule/ }).click();
  await expect(alerts.getByRole("listitem")).toHaveCount(0);
  expect(backend.get().rules).toEqual([]);
  await alerts.getByRole("button", { name: "Delete all my alerts" }).click();
  await alerts.getByRole("button", { name: "Delete all", exact: true }).click();
  await expect(alerts.getByText("All alerts deleted.")).toBeVisible();
  await expect(alerts.getByText("Permission: Granted · Subscribed: No")).toBeVisible();
  expect(backend.get()).toBeUndefined();
  expect(await page.evaluate(() => localStorage.getItem("test-endpoint"))).toBeNull();
});

test("iOS in browser mode shows install instructions without requesting permission", async ({ context, page, hasTouch }) => {
  test.skip(!hasTouch, "Uses the iOS browser profile");
  await fakeSubscription(context, false);
  const backend = await mockAlerts(context);
  await page.goto("/");
  await page.getByRole("button", { name: "Alerts", exact: true }).click();
  const alerts = page.getByRole("dialog", { name: "Alerts" });
  await expect(alerts.getByText("Install this site to your home screen first", { exact: false })).toBeVisible();
  await expect(alerts.getByRole("button", { name: "Enable notifications" })).toBeHidden();
  expect(await page.evaluate(() => window.permissionPrompts)).toBe(0);
  expect(backend.registrations).toEqual([]);
});

test("a focus refresh cannot advance the revision of an open rule draft", async ({ context, page, hasTouch }) => {
  await fakeSubscription(context, hasTouch ? true : undefined);
  const backend = await mockAlerts(context);
  async function open(tab) {
    await tab.goto("/");
    await tab.getByRole("button", { name: "Alerts", exact: true }).click();
    return tab.getByRole("dialog", { name: "Alerts" });
  }

  const alerts = await open(page);
  await alerts.getByRole("button", { name: "Enable notifications" }).click();
  await alerts.getByRole("button", { name: "Add rule" }).click();
  await alerts.getByLabel("Keywords").fill("original");
  await alerts.getByRole("button", { name: "Save rule" }).click();
  await alerts.getByRole("button", { name: "Edit rule original" }).click();

  const second = await open(await context.newPage());
  await second.getByRole("button", { name: "Edit rule original" }).click();
  await second.getByLabel("Keywords").fill("updated");
  await second.getByRole("button", { name: "Save rule" }).click();
  await expect(second.getByRole("button", { name: "Edit rule updated" })).toBeEnabled();

  await page.clock.setFixedTime(Date.now() + 3000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(alerts.getByRole("button", { name: "Edit rule updated" })).toBeEnabled();
  await expect(alerts.getByLabel("Keywords")).toHaveValue("original");
  const points = alerts.getByRole("spinbutton", { name: "Minimum points" });
  await points.fill("200");
  await alerts.getByRole("button", { name: "Save rule" }).click();
  await expect(alerts.getByText("Alert rules changed in another tab.", { exact: false })).toBeVisible();
  expect(backend.get().rules[0]).toMatchObject({ keywords: ["updated"], minPoints: 100 });
  await expect(points).toHaveValue("200");

  await alerts.getByRole("button", { name: "Edit rule updated" }).click();
  await points.fill("200");
  await alerts.getByRole("button", { name: "Save rule" }).click();
  await expect(alerts.getByText("200+ points")).toBeVisible();
  expect(backend.get().rules[0]).toMatchObject({ keywords: ["updated"], minPoints: 200 });
});

test("a cold notification URL previews the story, cleans up the URL and preserves Back", async ({ page }) => {
  await page.goto("/?story=1&source=push");
  const preview = page.getByRole("dialog", { name: "Test discussion" });
  await expect(preview.getByRole("heading", { name: "Test discussion" })).toBeVisible();
  await expect(preview.getByText("Safe story text")).toBeVisible();
  await expect(preview.getByRole("link", { name: "Open in browser" })).toHaveAttribute("href", "https://news.ycombinator.com/item?id=1");
  await expect(page).toHaveURL(/\/\?source=push$/);
  await page.goBack();
  await expect(preview).toBeHidden();
  await expect(page).toHaveURL(/\/\?source=push$/);
});

test("notification previews and browser links use the submitted HN destination", async ({ page }) => {
  const targets = {
    31: "https://news.ycombinator.com/item?id=2#500",
    32: "https://news.ycombinator.com/user?id=pg",
  };
  await page.route("**/api/item?id=*", route => {
    const id = Number(new URL(route.request().url()).searchParams.get("id"));
    return route.fulfill({ json: { id, url: targets[id], title: "Alert story " + id } });
  });
  await page.route("**/api/embeddable?id=*", route => route.fulfill({ json: { embeddable: false } }));
  await page.route("**/api/reader?id=*", route => {
    const id = new URL(route.request().url()).searchParams.get("id");
    return route.fulfill({ json: { title: "Linked HN page for " + id, html: "<p>Preview content</p>" } });
  });

  for (const [id, url] of Object.entries(targets)) {
    await page.goto("/?story=" + id);
    const preview = page.getByRole("dialog", { name: "Alert story " + id });
    await expect(preview.getByRole("heading", { name: "Linked HN page for " + id })).toBeVisible();
    await expect(preview.getByRole("link", { name: "Open in browser" })).toHaveAttribute("href", url);
    await expect(preview.getByRole("link", { name: "HN discussion" })).toHaveAttribute("href", "#/item/" + id);
  }
});

test("the worker displays every push, counts badges, and routes notification clicks", async ({ context, page }) => {
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const worker = context.serviceWorkers()[0];
  const notification = await worker.evaluate(async () => {
    const notifications = [];
    const prototype = Object.getPrototypeOf(self.registration);
    const original = prototype.showNotification;
    // Headless Chromium on macOS does not grant worker notification permission.
    prototype.showNotification = async (title, options) => { notifications.push({ title, ...options }); };
    globalThis.badgeLog = [];
    Object.defineProperty(navigator, "setAppBadge", { value: async value => badgeLog.push(value), configurable: true });
    Object.defineProperty(navigator, "clearAppBadge", { value: async () => badgeLog.push(0), configurable: true });
    try {
      for (const json of [
        () => ({ id: 1, title: "Test discussion", points: 105, comments: 3, domain: "news.ycombinator.com",
          url: "https://news.ycombinator.com/item?id=1", hnUrl: "https://news.ycombinator.com/item?id=1" }),
        () => { throw new Error("Invalid payload"); },
      ]) {
        const event = new Event("push");
        event.data = { json };
        let pending;
        event.waitUntil = promise => { pending = promise; };
        self.dispatchEvent(event);
        await pending;
      }
    } finally {
      prototype.showNotification = original;
    }
    return { notifications: notifications.map(({ title, body, tag, icon }) => ({ title, body, tag, icon })),
      badgeLog: [...badgeLog] };
  });
  expect(notification.notifications).toContainEqual({ title: "Test discussion", body: "105 pts, 3 comments, news.ycombinator.com",
    tag: "1", icon: "/android-chrome-192x192.png" });
  expect(notification.notifications.map(item => item.title)).toContain("HNx alerts");
  expect(notification.badgeLog.slice(-2)).toEqual([1, 2]);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => worker.evaluate(() => hnxAlertDevice.saved("unseen"))).toBe(0);

  await page.getByRole("button", { name: "Alerts", exact: true }).click();
  const routes = await worker.evaluate(async () => {
    const realMatchAll = clients.matchAll.bind(clients);
    const realOpenWindow = clients.openWindow;
    const opened = [];
    let closed = 0;
    const click = async () => {
      const event = new Event("notificationclick");
      event.notification = { data: { id: 1 }, close: () => { closed++; } };
      let pending;
      event.waitUntil = promise => { pending = promise; };
      self.dispatchEvent(event);
      await pending;
    };
    try {
      clients.openWindow = async url => { opened.push(url); };
      clients.matchAll = async params => (await realMatchAll(params)).map(client => ({
        url: client.url, focus: async () => client,
      }));
      await click();
      clients.matchAll = async () => [];
      await click();
      return { opened, closed };
    } finally {
      delete clients.matchAll;
      if (realOpenWindow) delete clients.openWindow;
    }
  });
  expect(routes).toEqual({ opened: ["/?story=1"], closed: 2 });
  await expect(page.getByRole("dialog", { name: "Test discussion" })).toBeVisible();
});
