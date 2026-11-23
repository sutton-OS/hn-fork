const assert = require("node:assert/strict");
const { createECDH, randomBytes, randomUUID } = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, dirname } = require("node:path");
const { Readable } = require("node:stream");
const { setTimeout: delay } = require("node:timers/promises");
const { promisify } = require("node:util");
const { test } = require("node:test");
const { createAlertHandler } = require("../lib/alert-api");
const { createJobHandler, compileRule, fetchStories, matchesRule, runAlertJob } = require("../lib/alert-job");
const { alertEndpoint, rulesFrom, subscriptionFrom } = require("../lib/alert-validation");
const { createAlertStore } = require("../lib/alert-store");

const origin = "https://hnx.example";
const subscriber = endpoint => {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return { endpoint, keys: { p256dh: key.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url") } };
};
const subscriberFrom = name => subscriptionFrom(subscriber("https://web.push.apple.com/" + name));
const rule = overrides => ({
  id: randomUUID(), keywords: ["swift", '"open source"'], domain: "github.com",
  minPoints: 100, frontPage: true, enabled: true, ...overrides,
});
const story = (id, overrides) => ({
  id, title: "SWIFT adds an open source library", score: 100, descendants: 12,
  url: "https://github.com/example/project", domain: "github.com", rank: 30, ...overrides,
});

async function request(handler, body, { headers = {}, method = "POST", ip = "127.0.0.2", stream } = {}) {
  const responseHeaders = new Map();
  let status;
  let result;
  await handler(Object.assign(stream || {}, {
    method, body, socket: { remoteAddress: ip },
    headers: { origin, "content-type": "application/json", ...headers },
  }), {
    setHeader(name, value) { responseHeaders.set(name, value); },
    status(value) { status = value; },
    send(value) { result = JSON.parse(value); },
  });
  return { status, result, headers: responseHeaders };
}

test("alert keywords, exact phrases, domains, score and front-page rank", async () => {
  const { parseKeywords } = await import("../public/modules/alert-rules.js");
  assert.deepEqual(parseKeywords('swift, privacy "open source"'), ["swift", "privacy", '"open source"']);
  assert.equal(parseKeywords('swift "open source'), null);
  assert.equal(parseKeywords("a b c d e f"), null);
  assert.equal(parseKeywords("a".repeat(51)), null);
  assert.equal(parseKeywords('"open source"swift'), null);
  const [validated] = await rulesFrom([rule({ domain: " GitHub.COM. " })]);
  const compiled = compileRule(validated);
  assert.ok(matchesRule(story(1, { title: "A Swift compiler" }), compiled));
  assert.ok(matchesRule(story(1, { title: "An OPEN SOURCE tool", domain: "gist.github.com" }), compiled));
  for (const fields of [
    { title: "Swifter and open-source" }, { title: "open  source" }, { rank: 31 }, { rank: null },
    { score: 99 }, { domain: "examplegithub.com" }, { domain: "github.com.example" },
  ]) assert.equal(matchesRule(story(1, fields), compiled), false);
  assert.ok(matchesRule(story(1, { title: "A C++ tool" }), compileRule(rule({ keywords: ["C++"] }))));
  await assert.rejects(rulesFrom(Array.from({ length: 11 }, () => rule())), /up to 10/);
});

test("allowlist rejects arbitrary hosts, deceptive suffixes, credentials, and custom ports", async () => {
  for (const endpoint of [
    "https://127.0.0.1/message", "https://example.org/push", "https://push.apple.com.example.org/token",
    "https://notpush.apple.com/token", "https://fcm.googleapis.com@127.0.0.1/push",
    "http://web.push.apple.com/token", "https://a.notify.windows.com:444/token",
    "https://user@fcm.googleapis.com/token", "https://fcm.googleapis.com/token#fragment",
  ]) assert.equal(alertEndpoint(endpoint), null, endpoint);
  for (const host of ["web.push.apple.com", "relay.push.apple.com", "fcm.googleapis.com",
    "updates.push.services.mozilla.com", "wns.notify.windows.com"]) {
    const endpoint = "https://" + host + "/push/token";
    assert.equal(alertEndpoint(endpoint), endpoint);
  }
  const configFor = () => ({ origin, secret: "test", store: { countRequest: async () => 1 } });
  const handler = createAlertHandler("subscribe", { configFor });
  assert.equal((await request(handler, { subscription: subscriber("https://example.org/push"), rules: [] })).status, 400);
  const crossOrigin = await request(handler, {}, { headers: { origin: "https://different.example" } });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.has("access-control-allow-origin"), false);
  assert.equal((await request(handler, {}, { headers: { "content-length": "16385" } })).status, 413);
  assert.equal((await request(handler, undefined, {
    stream: Readable.from([Buffer.alloc(10240), Buffer.alloc(10240)]),
  })).status, 413);
  assert.equal((await request(handler, {})).headers.get("access-control-allow-origin"), origin);
});

test("HN candidates use each feed and item once with a shared five-minute cache", async () => {
  const requests = [];
  let cached = null;
  let parallel = 0;
  let peak = 0;
  const lists = {
    topstories: Array.from({ length: 35 }, (_, i) => i + 1),
    beststories: [1, 2, 36, 37],
    newstories: [36, 38],
  };
  const store = { cachedStories: async () => cached, cacheStories: async items => { cached = items; } };
  const items = await fetchStories({ store, signal: new AbortController().signal, async readJSON(url) {
    const route = url.split("/v0/")[1].replace(".json", "");
    requests.push(route);
    if (lists[route]) return lists[route];
    const id = Number(route.split("/")[1]);
    peak = Math.max(peak, ++parallel);
    await delay(1);
    parallel--;
    return { id, type: "story", title: "Swift", score: 100, descendants: 2,
      ...(id === 37 ? { deleted: true } : {}) };
  } });
  assert.equal(new Set(requests).size, 41);
  assert.equal(requests.length, 41);
  assert.equal(peak, 10);
  assert.equal(items.find(item => item.id === 30).rank, 30);
  assert.equal(items.find(item => item.id === 36).rank, null);
  assert.equal(items.find(item => item.id === 38).domain, "news.ycombinator.com");
  assert.equal(items.some(item => item.id === 37), false);
  assert.equal(await fetchStories({ store, readJSON: () => assert.fail("cache miss") }), items);
});

test("scheduled endpoint requires the configured bearer", async () => {
  const secret = randomBytes(32).toString("hex");
  const handler = createJobHandler({ configFor: () => ({ store: {}, secret }), run: async () => ({ pushesSent: 0 }) });
  assert.equal((await request(handler, null, { method: "GET" })).status, 401);
  assert.equal((await request(handler, null, { method: "GET",
    headers: { authorization: "Bearer " + secret } })).status, 200);
});

test("scheduled endpoint reports failure when every attempted push fails", async () => {
  const secret = randomBytes(32).toString("hex");
  for (const [stats, status] of [
    [{ matches: 1, pushesSent: 0, failed: 1 }, 503],
    [{ matches: 2, pushesSent: 1, failed: 1 }, 200],
    [{ matches: 1, pushesSent: 0, failed: 0, subscriptionsPruned: 1 }, 200],
    [{ matches: 0, pushesSent: 0, failed: 0 }, 200],
    [{ matches: 1, pushesSent: 1, failed: 0, incomplete: true }, 503],
  ]) {
    const handler = createJobHandler({ configFor: () => ({ store: {}, secret }), run: async () => stats });
    const response = await request(handler, null, { method: "GET", headers: { authorization: "Bearer " + secret } });
    assert.equal(response.status, status);
    assert.deepEqual(response.result, stats);
  }
});

const redisPath = process.env.HNX_REDIS_SERVER;
async function redisCommands(t) {
  const dir = await mkdtemp(join(tmpdir(), "hnx-alerts-"));
  const socket = join(dir, "redis.sock");
  const redis = spawn(redisPath, ["--port", "0", "--unixsocket", socket, "--save", "",
    "--appendonly", "no", "--dir", dir], { stdio: "ignore" });
  t.after(async () => {
    if (redis.exitCode === null && redis.pid) {
      const closed = new Promise(resolve => redis.once("close", resolve));
      redis.kill();
      await closed;
    }
    await rm(dir, { recursive: true, force: true });
  });
  const execute = promisify(execFile);
  async function command(...args) {
    const { stdout } = await execute(join(dirname(redisPath), "redis-cli"),
      ["-s", socket, "--json", ...args]);
    return JSON.parse(stdout);
  }
  let ready = false;
  for (let n = 0; n < 50 && !ready && redis.exitCode === null; n++) {
    try { ready = await command("PING") === "PONG"; } catch { await delay(10); }
  }
  assert.ok(ready, "The temporary Redis socket must accept connections");
  return command;
}

function storeFor(command) {
  return createAlertStore({ url: "https://redis.example", token: randomUUID(),
    async fetcher(_url, options) {
      return { ok: true, json: async () => ({ result: await command(...JSON.parse(options.body)) }) };
    } });
}

test("Redis atomically stores, dedupes, caps, rotates and prunes alerts", { skip: !redisPath }, async t => {
  const command = await redisCommands(t);
  const store = storeFor(command);
  const current = subscriber("https://web.push.apple.com/device");
  const rotated = subscriber("https://fcm.googleapis.com/fcm/send/device");
  const secret = randomBytes(32).toString("hex");
  const configFor = () => ({ origin, secret, store });
  const sent = [];
  const api = action => createAlertHandler(action, { configFor, push: async (_device, data) => { sent.push(data); } });
  const firstRules = [rule({ enabled: false })];
  const subscribe = await request(api("subscribe"), { subscription: current, rules: firstRules });
  const { id, revision } = subscribe.result;
  const identity = { id, auth: current.keys.auth };
  assert.equal(id, subscriptionFrom(current).id);
  assert.equal((await request(api("rules"), identity)).result.rules[0].enabled, false);
  assert.equal((await request(api("rules"), { ...identity, auth: rotated.keys.auth })).status, 404);
  const newRules = [rule({ domain: "", frontPage: false })];
  const update = await request(api("rules"), { ...identity, revision, rules: newRules });
  assert.deepEqual(update.result.rules, newRules);
  assert.equal((await request(api("rules"), { ...identity, revision, rules: [] })).status, 409);

  let items = [story(1, { score: 99 })];
  let fetches = 0;
  const run = send => runAlertJob({ store, send, load: async () => { fetches++; return [...items]; } });
  const push = async (_device, data) => { sent.push(data); };
  assert.equal((await run(push)).pushesSent, 0);
  items[0].score = 100;
  assert.equal((await run(push)).pushesSent, 1);
  assert.equal((await run(push)).pushesSent, 0);
  assert.deepEqual(sent.map(payload => payload.id), [1]);
  items = Array.from({ length: 8 }, (_, i) => story(i + 1));
  const overlap = await Promise.all([run(push), run(push)]);
  assert.equal(overlap.reduce((sum, entry) => sum + entry.pushesSent, 0), 4);
  assert.ok(overlap.some(entry => entry.skipped));
  assert.equal(sent.length, 5);
  assert.equal(sent.at(-1).title, "4 more stories match your alerts");
  assert.equal(fetches, 4);

  const renewed = (await request(api("subscribe"), { subscription: rotated, rules: [], previous: identity })).result;
  assert.deepEqual(renewed.rules, newRules);
  assert.equal(await store.get(id), null);
  assert.equal((await request(api("test"), { id: renewed.id, auth: rotated.keys.auth })).status, 429);
  const dedupeKey = "hnx:alerts:v1:notified:" + renewed.id;
  assert.ok(await command("PTTL", dedupeKey) > 600000000);
  // Advance the Redis history without waiting an hour or a week.
  await command("DEL", "hnx:alerts:v1:hour:" + renewed.id);
  assert.equal((await run(push)).pushesSent, 0);
  items = [story(9)];
  const gone = await run(async () => { throw Object.assign(new Error(), { statusCode: 410 }); });
  assert.equal(gone.subscriptionsPruned, 1);
  assert.equal(await store.get(renewed.id), null);
  assert.equal(await command("EXISTS", dedupeKey), 0);

  const rejoined = (await request(api("subscribe"), { subscription: rotated, rules: newRules })).result;
  const rejoinedIdentity = { id: rejoined.id, auth: rotated.keys.auth };
  const missing = createAlertHandler("test", { configFor, async push() {
    throw Object.assign(new Error(), { statusCode: 404 });
  } });
  assert.equal((await request(missing, rejoinedIdentity)).status, 410);
  assert.equal(await store.get(rejoined.id), null);
  await request(api("subscribe"), { subscription: rotated, rules: newRules });
  const manual = await request(api("test"), rejoinedIdentity);
  assert.equal(manual.status, 200);
  assert.match(sent.at(-1).title, /test notification/);
  assert.equal((await request(api("unsubscribe"), rejoinedIdentity)).status, 200);
  assert.equal(await store.get(rejoined.id), null);
  const requests = await Promise.all(Array.from({ length: 60 }, () => request(api("rules"), rejoinedIdentity)));
  assert.ok(requests.some(item => item.status === 429));
  assert.equal((await request(api("rules"), rejoinedIdentity)).status, 429);
  assert.equal((await request(api("rules"), rejoinedIdentity, { ip: "127.0.0.3" })).status, 404);
});

test("Provider rejections free the hourly slot and all stories for retry", { skip: !redisPath }, async t => {
  const command = await redisCommands(t);
  const store = storeFor(command);
  const device = await store.register(subscriberFrom("retry"), [rule()]);
  const history = "hnx:alerts:v1:notified:" + device.id;
  const hourly = "hnx:alerts:v1:hour:" + device.id;
  let items = [story(1)];
  const run = send => runAlertJob({ store, send, load: async () => [...items] });
  const reject = () => { throw Object.assign(new Error("Push rejected"), { statusCode: 403 }); };
  const sent = [];
  const accept = async (_device, payload) => { sent.push(payload); };

  assert.equal((await run(reject)).failed, 1);
  assert.equal(await command("ZCARD", hourly), 0);
  assert.equal(await command("ZCARD", history), 0);
  assert.equal((await run(accept)).pushesSent, 1);
  assert.equal(sent[0].id, 1);

  items = Array.from({ length: 8 }, (_, i) => story(i + 1));
  const rejected = await run(async (subscription, payload) => {
    if (payload.tag === "hnx-alert-summary") reject();
    await accept(subscription, payload);
  });
  assert.equal(rejected.pushesSent, 3);
  assert.equal(rejected.failed, 1);
  assert.equal(await command("ZCARD", hourly), 4);
  assert.deepEqual(await command("ZRANGE", history, "0", "-1"), ["1", "2", "3", "4"]);

  assert.equal((await run(accept)).pushesSent, 1);
  assert.equal(sent.at(-1).title, "4 more stories match your alerts");
  assert.equal(await command("ZCARD", history), 8);
  assert.equal(await command("ZCARD", hourly), 5);

  await command("DEL", hourly);
  items = [story(9)];
  assert.equal((await run(async () => { throw new Error("Socket timeout"); })).failed, 1);
  assert.equal(await command("ZCARD", hourly), 1);
  assert.equal((await run(accept)).pushesSent, 0);
});

test("Interrupted jobs resume within and between Redis scan pages", { skip: !redisPath }, async t => {
  const command = await redisCommands(t);
  const store = storeFor(command);
  const active = await Promise.all(["first", "second", "third"].map(name =>
    store.register(subscriberFrom(name), [rule()])));
  const disabled = await Promise.all(Array.from({ length: 9 }, (_, i) =>
    store.register(subscriberFrom("disabled-" + i), [])));
  const keyFor = subscription => "hnx:alerts:v1:subscription:" + subscription.id;
  const pages = {
    "0": ["512", [active[0], ...disabled, active[1]].map(keyFor)],
    "512": ["64", []],
    "64": ["0", [keyFor(active[2])]],
  };
  const cursors = [];
  const sent = [];
  function run({ stopAfterLoad = false, stopAfterReserve = false, stopAfterSend = false } = {}) {
    const controller = new AbortController();
    const jobStore = storeFor((action, ...args) => {
      if (action !== "SCAN") return command(action, ...args);
      const [cursor] = args;
      cursors.push(cursor);
      return pages[cursor];
    });
    if (stopAfterReserve) {
      const reserve = jobStore.reserve;
      jobStore.reserve = async (...args) => {
        const result = await reserve(...args);
        controller.abort();
        return result;
      };
    }
    return runAlertJob({
      store: jobStore,
      signal: controller.signal,
      async load() {
        if (stopAfterLoad) controller.abort();
        return [story(1)];
      },
      async send(device) {
        sent.push(device.id);
        if (stopAfterSend) controller.abort();
      },
    });
  }

  assert.equal((await run({ stopAfterLoad: true })).incomplete, true);
  assert.equal((await run({ stopAfterReserve: true })).incomplete, true);
  assert.deepEqual(sent, []);
  for (const device of active) {
    const stats = await run({ stopAfterSend: true });
    assert.equal(stats.incomplete, true);
    assert.equal(stats.pushesSent, 1);
    assert.equal(sent.at(-1), device.id);
  }
  assert.deepEqual(cursors, ["0", "0", "0", "512", "64"]);
  assert.equal((await run()).pushesSent, 0);
  assert.deepEqual(cursors.slice(5), ["0", "512", "64"]);
});
