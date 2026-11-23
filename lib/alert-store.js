const { randomUUID } = require("node:crypto");

const prefix = "hnx:alerts:v1:";
const subscriptionPrefix = prefix + "subscription:";
const subscriptionKeys = id => [subscriptionPrefix + id, prefix + "notified:" + id, prefix + "hour:" + id];
const jobKey = prefix + "job";
const scanKey = prefix + "scan";
const cacheKey = prefix + "stories";

const writeSubscription = `
local current = redis.call("GET", KEYS[1])
local incoming = cjson.decode(ARGV[1])
if current then
  local item = cjson.decode(current)
  if item.keys.auth ~= incoming.keys.auth and (#KEYS ~= 3 or item.keys.auth ~= ARGV[3]) then return false end
  item.keys = incoming.keys
  item.lastSeenAt = incoming.lastSeenAt
  local saved = cjson.encode(item)
  redis.call("SET", KEYS[1], saved)
  return saved
end
if #KEYS == 6 then
  local previous = redis.call("GET", KEYS[4])
  if previous then
    local item = cjson.decode(previous)
    if item.keys.auth ~= ARGV[3] then return false end
    incoming.rulesJSON = item.rulesJSON
    incoming.createdAt = item.createdAt
    for i = 2, 3 do
      if redis.call("EXISTS", KEYS[i + 3]) == 1 then
        redis.call("RENAME", KEYS[i + 3], KEYS[i])
      end
    end
    redis.call("DEL", KEYS[4])
  elseif ARGV[2] ~= "create" then return false end
elseif ARGV[2] ~= "create" then return false end
local saved = cjson.encode(incoming)
redis.call("SET", KEYS[1], saved)
return saved
`;

const editRules = `
local raw = redis.call("GET", KEYS[1])
if not raw then return {404} end
local item = cjson.decode(raw)
if item.keys.auth ~= ARGV[1] then return {404} end
if item.revision ~= ARGV[2] then return {409, raw} end
item.revision = ARGV[3]
item.rulesJSON = ARGV[4]
item.lastSeenAt = tonumber(ARGV[5])
local saved = cjson.encode(item)
redis.call("SET", KEYS[1], saved)
return {200, saved}
`;

const deleteSubscription = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local item = cjson.decode(raw)
if item.keys.auth ~= ARGV[1] then return -1 end
if ARGV[2] ~= "" and item.keys.p256dh ~= ARGV[2] then return 0 end
redis.call("DEL", unpack(KEYS))
return 1
`;

// Claim every story included in a push before sending. The same rolling window
// accounts for single stories, summaries, and manual tests.
const reservePush = `
local raw = redis.call("GET", KEYS[1])
if not raw or cjson.decode(raw).revision ~= ARGV[1] then return false end
local clock = redis.call("TIME")
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local hour = 3600000
local week = 604800000
redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", now - week)
redis.call("ZREMRANGEBYSCORE", KEYS[3], "-inf", now - hour)
local slots = 5 - redis.call("ZCARD", KEYS[3])
local fresh = {}
for i = 4, #ARGV do
  if not redis.call("ZSCORE", KEYS[2], ARGV[i]) then
    fresh[#fresh + 1] = ARGV[i]
  end
end
if slots <= 0 or (#fresh == 0 and ARGV[3] ~= "test") then return {#fresh} end
local group = {}
if ARGV[3] ~= "test" then
  group = slots == 1 and #fresh > 1 and fresh or {fresh[1]}
end
local token = ARGV[2]
redis.call("ZADD", KEYS[3], now, token)
for _, id in ipairs(group) do redis.call("ZADD", KEYS[2], now, id) end
redis.call("PEXPIRE", KEYS[2], week)
redis.call("PEXPIRE", KEYS[3], hour)
return {#fresh, now, token, group}
`;

const releasePush = `
local score = redis.call("ZSCORE", KEYS[2], ARGV[1])
if score and tonumber(score) == tonumber(ARGV[2]) then
  redis.call("ZREM", KEYS[2], ARGV[1])
  for i = 3, #ARGV do
    local stamp = redis.call("ZSCORE", KEYS[1], ARGV[i])
    if stamp and tonumber(stamp) == tonumber(score) then
      redis.call("ZREM", KEYS[1], ARGV[i])
    end
  end
end
return 1
`;

const hitLimit = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
return count
`;

const saveScan = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] == "" then
  redis.call("DEL", KEYS[2])
else
  redis.call("SET", KEYS[2], ARGV[2])
end
return 1
`;

function parseSubscription(raw) {
  if (!raw) return null;
  const { rulesJSON, ...subscription } = JSON.parse(raw);
  return { ...subscription, rules: JSON.parse(rulesJSON) };
}

function createAlertStore({ url, token, fetcher = fetch }) {
  async function command(...args) {
    const response = await fetcher(url, {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(args.map(String)),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Alert storage request failed.");
    const reply = await response.json();
    if (reply.error || !Object.hasOwn(reply, "result")) throw new Error("Alert storage command failed.");
    return reply.result;
  }
  const evalScript = (script, keys, ...args) => command("EVAL", script, keys.length, ...keys, ...args);

  return {
    async register(subscription, rules, previous) {
      const now = Date.now();
      const record = { ...subscription, rulesJSON: JSON.stringify(rules ?? []), createdAt: now,
        lastSeenAt: now, revision: randomUUID() };
      const keys = subscriptionKeys(subscription.id);
      if (previous && previous.id !== subscription.id) keys.push(...subscriptionKeys(previous.id));
      return parseSubscription(await evalScript(writeSubscription, keys, JSON.stringify(record),
        rules === undefined ? "existing" : "create", previous?.auth ?? ""));
    },
    async get(id) {
      return parseSubscription(await command("GET", subscriptionPrefix + id));
    },
    async setRules(identity, revision, rules) {
      const [status, raw] = await evalScript(editRules, [subscriptionPrefix + identity.id],
        identity.auth, revision, randomUUID(), JSON.stringify(rules), Date.now());
      return { status, subscription: parseSubscription(raw) };
    },
    async remove(id, auth, p256dh = "") {
      return Number(await evalScript(deleteSubscription, subscriptionKeys(id), auth, p256dh));
    },
    async *subscriptions({ owner, batchSize, signal }) {
      if (signal.aborted) return;
      const saved = await command("GET", scanKey);
      let { cursor, pending } = saved ? JSON.parse(saved) : { cursor: "0", pending: [] };
      do {
        if (signal.aborted) return;
        if (!pending.length) {
          const [next, keys] = await command("SCAN", cursor, "MATCH", subscriptionPrefix + "*", "COUNT", 50);
          cursor = String(next);
          pending = keys;
        }
        if (pending.length) {
          if (signal.aborted) return;
          const keys = pending.slice(0, batchSize);
          const items = await command("MGET", ...keys);
          yield items.filter(Boolean).map(parseSubscription);
          // Advancing the iterator acknowledges the batch. Breaking leaves it pending.
          pending = pending.slice(keys.length);
        }
        const checkpoint = cursor !== "0" || pending.length ? JSON.stringify({ cursor, pending }) : "";
        if (!await evalScript(saveScan, [jobKey, scanKey], owner, checkpoint)) {
          throw new Error("Alert job lease expired.");
        }
      } while (cursor !== "0" || pending.length);
    },
    async reserve(subscription, storyIds, { test = false } = {}) {
      const result = await evalScript(reservePush, subscriptionKeys(subscription.id), subscription.revision,
        randomUUID(), test ? "test" : "stories", ...storyIds);
      const [matches = 0, stamp, token, ids] = result || [];
      return { matches, group: token ? { token, stamp, ids } : null };
    },
    release(id, group) {
      return evalScript(releasePush, subscriptionKeys(id).slice(1), group.token, group.stamp, ...group.ids);
    },
    countRequest(key, seconds) {
      return evalScript(hitLimit, [prefix + "ip:" + key], seconds);
    },
    async lease() {
      const owner = randomUUID();
      const acquired = await command("SET", jobKey, owner, "NX", "EX", 210);
      return acquired === "OK" ? owner : null;
    },
    releaseLease(owner) {
      return evalScript(`if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end`,
        [jobKey], owner);
    },
    async cachedStories() {
      const raw = await command("GET", cacheKey);
      return raw ? JSON.parse(raw) : null;
    },
    cacheStories(snapshot) {
      return command("SET", cacheKey, JSON.stringify(snapshot), "EX", 300);
    },
  };
}

module.exports = { createAlertStore };
