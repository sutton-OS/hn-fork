const { timingSafeEqual } = require("node:crypto");
const { HN_BASE_URL, FEED_MAP, normalizeItem, fetchJSON, mapWithConcurrency, sendJSON } = require("./hn");
const { alertConfig } = require("./alert-api");
const { deliverAlert, sendAlert, storyPayload, summaryPayload } = require("./alert-push");

const MAX_PER_FEED = 500;
const HN_HOST = "news.ycombinator.com";
const CONCURRENCY = 10;

function compileRule(rule) {
  const word = "[\\p{L}\\p{M}\\p{N}_]";
  const terms = rule.keywords.map(keyword => {
    const text = keyword.startsWith('"') ? keyword.slice(1, -1) : keyword;
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return { ...rule, pattern: new RegExp("(?<!" + word + ")(?:" + terms.join("|") + ")(?!" + word + ")", "iu") };
}

function matchesRule(story, rule) {
  return story.score >= rule.minPoints &&
    (!rule.frontPage || (story.rank !== null && story.rank <= 30)) &&
    (!rule.domain || story.domain === rule.domain || story.domain.endsWith("." + rule.domain)) &&
    rule.pattern.test(story.title);
}

function candidateFrom(raw, rank) {
  const item = normalizeItem(raw);
  if (!item || item.type !== "story" || !item.title.trim() || item.dead || item.deleted) return null;
  let url = "";
  let domain = HN_HOST;
  try {
    const parsed = new URL(item.url);
    if (["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password &&
        Buffer.byteLength(parsed.href) <= 2048) {
      url = parsed.href;
      domain = parsed.hostname.toLowerCase().replace(/\.$/, "");
    }
  } catch { /* HN self posts have no publisher URL. */ }
  url ||= "https://" + HN_HOST + "/item?id=" + item.id;
  return { id: item.id, score: item.score, descendants: item.descendants,
    title: item.title.slice(0, 1024), url, domain, rank: rank.get(item.id) ?? null };
}

async function fetchStories({ store, signal, readJSON = fetchJSON }) {
  const cached = await store.cachedStories();
  if (cached !== null) return cached;
  const request = path => readJSON(HN_BASE_URL + "/" + path + ".json", {
    signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]), userAgent: "hnx-alerts/1.0",
  });
  const feeds = await Promise.all([FEED_MAP.top, FEED_MAP.best, FEED_MAP.new].map(async path => {
    const ids = await request(path);
    if (!Array.isArray(ids)) throw new Error("Invalid story list.");
    return ids.slice(0, MAX_PER_FEED);
  }));
  const rank = new Map(feeds[0].map((id, index) => [id, index + 1]));
  const ids = [...new Set(feeds.flat())].filter(id => Number.isSafeInteger(id) && id > 0);
  let complete = true;
  const items = await mapWithConcurrency(ids, CONCURRENCY, async id => {
    try {
      signal.throwIfAborted();
      const raw = await request("item/" + id);
      return candidateFrom(raw, rank);
    } catch {
      complete = false;
      return null;
    }
  });
  const stories = items.filter(Boolean);
  if (ids.length && !stories.length && !complete) throw new Error("Story details unavailable.");
  if (complete) await store.cacheStories(stories);
  return stories;
}

async function runAlertJob({ store, send, load = fetchStories, signal = AbortSignal.timeout(145000) }) {
  const owner = await store.lease();
  const stats = { storiesScanned: 0, matches: 0, pushesSent: 0, subscriptionsPruned: 0, failed: 0 };
  if (!owner) return { ...stats, skipped: "already running" };
  try {
    let stories;
    const visited = new Set();
    for await (const batch of store.subscriptions({ owner, batchSize: CONCURRENCY, signal })) {
      if (signal.aborted) break;
      const active = batch.filter(subscription => {
        if (visited.has(subscription.id)) return false;
        visited.add(subscription.id);
        return subscription.rules.some(rule => rule.enabled);
      });
      if (!active.length) continue;
      if (!stories) {
        const candidates = await load({ store, signal });
        if (signal.aborted) break;
        stories = new Map(candidates
          .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || b.score - a.score)
          .map(story => [String(story.id), story]));
        stats.storiesScanned = stories.size;
      }
      let batchInterrupted = false;
      await mapWithConcurrency(active, CONCURRENCY, async subscription => {
        try {
          const rules = subscription.rules.filter(rule => rule.enabled).map(compileRule);
          const matched = [];
          for (const [id, story] of stories) {
            if (rules.some(rule => matchesRule(story, rule))) matched.push(id);
          }
          if (!matched.length) return;
          // Reserve just before each send so an interrupted run leaves unattempted
          // stories available to the next run.
          for (let attempt = 0; attempt < 5; attempt++) {
            if (signal.aborted) {
              if (attempt === 0) batchInterrupted = true;
              break;
            }
            const { matches, group } = await store.reserve(subscription, matched);
            if (attempt === 0) stats.matches += matches;
            if (!group) break;
            if (signal.aborted) {
              if (attempt === 0) batchInterrupted = true;
              await store.release(subscription.id, group);
              break;
            }
            const payload = group.ids.length === 1
              ? storyPayload(stories.get(group.ids[0]))
              : summaryPayload(group.ids.length);
            const result = await deliverAlert({ store, subscription, group, payload, send });
            if (result === "pruned") {
              stats.subscriptionsPruned++;
              break;
            }
            if (result === "sent") stats.pushesSent++;
            else {
              if (result === "failed") stats.failed++;
              break;
            }
          }
        } catch {
          stats.failed++;
        }
      });
      if (batchInterrupted) break;
    }
    return signal.aborted ? { ...stats, incomplete: true } : stats;
  } finally {
    await store.releaseLease(owner).catch(() => {});
  }
}

function authorized(header, secret) {
  if (typeof header !== "string") return false;
  const supplied = Buffer.from(header);
  const expected = Buffer.from("Bearer " + secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function createJobHandler({ configFor = alertConfig, run = runAlertJob } = {}) {
  return async (req, res) => {
    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      return sendJSON(res, 405, { error: "Method not allowed." });
    }
    const config = configFor();
    if (!config) return sendJSON(res, 503, { error: "Push alerts are unavailable on this deployment." });
    if (!authorized(req.headers.authorization, config.secret)) {
      return sendJSON(res, 401, { error: "Unauthorized." });
    }
    try {
      const stats = await run({ store: config.store,
        send: (subscription, payload) => sendAlert(subscription, payload, config.vapid) });
      console.info("HNx alerts run", stats);
      const unavailable = stats.incomplete || (stats.failed > 0 && stats.pushesSent === 0);
      return sendJSON(res, unavailable ? 503 : 200, stats);
    } catch {
      console.error("HNx alerts run failed");
      return sendJSON(res, 503, { error: "Alert scan failed." });
    }
  };
}

module.exports = { compileRule, matchesRule, fetchStories, runAlertJob, createJobHandler };
