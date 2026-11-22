const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const originalFetch = global.fetch;
let moduleId = 0;
const client = () => import(`../public/modules/api.js?test=${moduleId++}`);
const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
afterEach(() => { global.fetch = originalFetch; });

describe("thread prefetch lifecycle", () => {
  it("consumes a prefetch once and fetches fresh data on revisits", async () => {
    const api = await client();
    let calls = 0;
    global.fetch = async () => json({ revision: ++calls });
    await api.prefetchThread(1);
    assert.equal((await api.fetchThread(1)).revision, 1);
    assert.equal((await api.fetchThread(1)).revision, 2);
    assert.equal(calls, 2);
  });

  it("expires old entries instead of returning stale comments", async t => {
    const api = await client();
    t.mock.timers.enable({ apis: ["Date"], now: 100 });
    let calls = 0;
    global.fetch = async () => json({ revision: ++calls });
    await api.prefetchThread(1);
    t.mock.timers.tick(30_001);
    assert.equal((await api.fetchThread(1)).revision, 2);
  });

  it("settles failed speculative requests and retries live", async () => {
    const api = await client();
    global.fetch = async () => { throw new Error("Offline"); };
    assert.equal(await api.prefetchThread(1), null);
    global.fetch = async () => json({ revision: 2 });
    assert.equal((await api.fetchThread(1)).revision, 2);
  });

  it("falls back when a consumed in-flight prefetch fails", async () => {
    const api = await client();
    let fail;
    global.fetch = () => new Promise((resolve, reject) => { fail = reject; });
    const prefetch = api.prefetchThread(1);
    const page = api.fetchThread(1);
    global.fetch = async () => json({ revision: 2 });
    fail(new Error("Offline"));
    assert.equal(await prefetch, null);
    assert.equal((await page).revision, 2);
  });

  it("aborts navigation without waiting for an outstanding prefetch", async () => {
    const api = await client();
    let finish;
    global.fetch = () => new Promise(resolve => { finish = () => resolve(json({ id: 1 })); });
    const prefetch = api.prefetchThread(1);
    const controller = new AbortController();
    const navigation = api.fetchThread(1, { signal: controller.signal });
    controller.abort();
    await assert.rejects(navigation, { name: "AbortError" });
    finish();
    await prefetch;
  });

  it("caps speculative work and cancels evicted requests", async () => {
    const api = await client();
    const signals = [];
    global.fetch = async (url, { signal }) => {
      signals.push(signal);
      return json({ id: Number(new URL(url, "https://hnx.example").searchParams.get("id")) });
    };
    for (let id = 1; id <= 25; id++) await api.prefetchThread(id);
    assert.equal(signals[0].aborted, true);
    await api.fetchThread(1);
    assert.equal(signals.length, 26);
  });

  it("allows just two concurrent speculative requests", async () => {
    const api = await client();
    const finish = [];
    global.fetch = () => new Promise(resolve => finish.push(resolve));
    const first = api.prefetchThread(1);
    const second = api.prefetchThread(2);
    assert.equal(api.prefetchThread(3), null);
    assert.equal(finish.length, 2);
    finish[0](json({ id: 1 }));
    await first;
    const third = api.prefetchThread(3);
    assert.equal(finish.length, 3);
    finish[1](json({ id: 2 }));
    finish[2](json({ id: 3 }));
    await Promise.all([second, third]);
  });
});

it("reads the story title before a later comment-stream failure", async () => {
  const api = await client();
  const encoder = new TextEncoder();
  let send;
  global.fetch = async (url) => {
    assert.match(url, /[&?]stream=1/);
    return new Response(new ReadableStream({ start(controller) { send = controller; } }), {
      headers: { "content-type": "application/x-ndjson" },
    });
  };
  const { parent, thread } = api.startDiscussion(1);
  send.enqueue(encoder.encode('{"parent":'));
  send.enqueue(encoder.encode('{"id":1,"title":"Early title"}}\n'));
  assert.equal((await parent).title, "Early title");
  send.enqueue(encoder.encode('{"error":"Comments unavailable"}\n'));
  send.close();
  await assert.rejects(thread, /Comments unavailable/);
});
