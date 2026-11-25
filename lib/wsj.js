const { createHash } = require("node:crypto");

const WSJ_FEED_BASE = "https://feeds.content.dowjones.io/public/rss";

/**
 * A story in several feeds keeps its first entry here, so the narrower sections lead.
 * The politics and economy feeds are last because their titles can be social posts. Another feed's headline is better.
 * `topOnly` feeds count toward Top without adding stories to New.
 */
const WSJ_FEEDS = [
  { path: "RSSWSJD", section: "Tech" },
  { path: "RSSMarketsMain", section: "Markets" },
  { path: "RSSUSnews", section: "U.S." },
  { path: "RSSWorldNews", section: "World" },
  { path: "WSJcomUSBusiness", section: "Business" },
  { path: "socialpoliticsfeed", section: "Politics" },
  { path: "socialeconomyfeed", section: "Economy", topOnly: true, rankOffset: 4 },
];

/** The news feeds also carry opinion, lifestyle, and shopping pages. */
const EXCLUDED_PATHS = new Set(["opinion", "buyside", "lifestyle", "style", "arts-culture"]);

/** Left out of Top only: trade newsletters, and market updates published on a schedule. */
const ROUTINE_PATH = /^\/(?:cfo-journal|cio-journal|cmo-today|logistics-report|pro|risk-compliance-journal|finance\/(?:commodities-futures|currencies))\//;
const ROUTINE_TITLE = /\bMarket Talk\b|\bWSJ Dollar Index\b|^The Morning Risk Report\b|^(?:Oil Prices|Treasury Yields|(?:Asian|European) Stock(?:s| Indexes))\b/;

const NEWSLETTER_NOTE = /\s+Read more in today[’']s WSJ [^.]{1,40} newsletter:?$/i;

const WSJ_LIMITS = {
  timeoutMs: 8000,
  maxBytes: 2 * 1024 * 1024,
  maxAgeSeconds: 7 * 24 * 60 * 60,
  maxStories: 252,
  topStories: 42,
  /** Top prefers the last day. Older stories only fill the gaps on quiet days. */
  topPreferredAgeSeconds: 24 * 60 * 60,
  topMaxAgeSeconds: 48 * 60 * 60,
  reuseMs: 60_000,
  freshReuseMs: 15_000,
  /** How long one section's last good copy may stand in for a failed request. */
  fallbackMs: 60 * 60 * 1000,
};

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXML(value) {
  return value.replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|(amp|lt|gt|quot|apos));/gi, (match, hex, decimal, name) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()];
    const code = hex ? parseInt(hex, 16) : Number(decimal);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  });
}

function readTag(xml, name) {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  if (!match) return "";
  const cdata = match[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return (cdata ? cdata[1] : decodeXML(match[1])).replace(/\s+/g, " ").trim();
}

/** Returns a canonical article URL without tracking parameters, or null for pages left out of the feed. */
function articleURL(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (url.hostname !== "wsj.com" && !url.hostname.endsWith(".wsj.com")) return null;
  const section = url.pathname.split("/")[1].toLowerCase();
  if (!section || EXCLUDED_PATHS.has(section)) return null;
  url.search = "";
  url.hash = "";
  return url.href;
}

/** Negative, so a WSJ story can never be taken for a Hacker News item. */
function storyId(key) {
  return -(createHash("sha256").update(key).digest().readUIntBE(0, 6) + 1);
}

function parseFeed(xml, section) {
  if (typeof xml !== "string" || xml.length > WSJ_LIMITS.maxBytes || !/<rss[\s>]/.test(xml)) {
    throw new Error("WSJ returned an invalid feed.");
  }
  const items = xml.split(/<item[\s>]/).slice(1);
  if (!items.length) throw new Error("WSJ returned an empty feed.");

  const stories = [];
  for (const raw of items) {
    const item = raw.split("</item>", 1)[0];
    const title = readTag(item, "title").replace(NEWSLETTER_NOTE, "");
    const url = articleURL(readTag(item, "link"));
    const time = Math.floor(Date.parse(readTag(item, "pubDate")) / 1000);
    if (!title || !url || !Number.isFinite(time)) continue;
    stories.push({
      id: storyId(readTag(item, "guid") || url),
      title,
      url,
      domain: "wsj.com",
      section: new URL(url).pathname.startsWith("/politics/") ? "Politics" : section,
      time,
    });
  }
  return stories;
}

/** Newest first, without duplicates or stories past the age limit. */
function mergeStories(lists, now = Math.floor(Date.now() / 1000)) {
  const ids = new Set();
  const urls = new Set();
  const stories = [];
  for (const story of lists.flat()) {
    if (ids.has(story.id) || urls.has(story.url) || now - story.time > WSJ_LIMITS.maxAgeSeconds) continue;
    ids.add(story.id);
    urls.add(story.url);
    // A scheduled date must not pin a story to the top.
    stories.push(story.time > now ? { ...story, time: now } : story);
  }
  return stories.sort((a, b) => b.time - a.time || a.id - b.id).slice(0, WSJ_LIMITS.maxStories);
}

function isRoutine({ title, url }) {
  return ROUTINE_PATH.test(new URL(url).pathname) || ROUTINE_TITLE.test(title);
}

/**
 * WSJ lists each section's lead stories first, so every section's first story comes before any section's second.
 * The economy feed is in time order instead. Its offset keeps data releases from outranking the leads.
 */
function rankStories(lists, offsets = [], now = Math.floor(Date.now() / 1000)) {
  const ranks = new Map();
  lists.forEach((list, index) => {
    list.filter((story) => !isRoutine(story)).forEach(({ url }, position) => {
      ranks.set(url, Math.min(ranks.get(url) ?? Infinity, position + (offsets[index] ?? 0)));
    });
  });
  const isOlder = ({ time }) => now - time > WSJ_LIMITS.topPreferredAgeSeconds;
  return mergeStories(lists, now)
    .filter((story) => ranks.has(story.url) && now - story.time <= WSJ_LIMITS.topMaxAgeSeconds)
    .sort((a, b) => isOlder(a) - isOlder(b) || ranks.get(a.url) - ranks.get(b.url) || b.time - a.time)
    .slice(0, WSJ_LIMITS.topStories);
}

async function fetchFeed({ path, section }, signal) {
  const response = await fetch(`${WSJ_FEED_BASE}/${path}`, {
    signal,
    headers: { accept: "application/rss+xml, application/xml, text/xml", "user-agent": "hnx-wsj/1.0" },
  });
  if (!response.ok) throw new Error(`WSJ request failed (${response.status}).`);
  return parseFeed(await response.text(), section);
}

/** One shared copy per warm function, so paging and concurrent readers do not refetch every section. */
function createWsjSource() {
  const sections = new Map();
  let snapshot = null;
  let loading = null;

  async function load() {
    const signal = AbortSignal.timeout(WSJ_LIMITS.timeoutMs);
    const results = await Promise.allSettled(WSJ_FEEDS.map((feed) => fetchFeed(feed, signal)));
    const loadedAt = Date.now();
    const failures = [];
    const lists = [];
    const offsets = [];
    const latest = [];
    results.forEach((result, index) => {
      const { path, topOnly = false, rankOffset = 0 } = WSJ_FEEDS[index];
      if (result.status === "fulfilled") sections.set(path, { stories: result.value, loadedAt });
      else failures.push({ topOnly, reason: result.reason });
      const section = sections.get(path);
      if (!section || loadedAt - section.loadedAt >= WSJ_LIMITS.fallbackMs) return;
      lists.push(section.stories);
      offsets.push(rankOffset);
      if (!topOnly) latest.push(section.stories);
    });
    const latestFailures = failures.filter(({ topOnly }) => !topOnly);
    if (latestFailures.length === WSJ_FEEDS.filter(({ topOnly }) => !topOnly).length) throw latestFailures[0].reason;
    snapshot = {
      latest: { stories: mergeStories(latest), partial: latestFailures.length > 0 },
      top: { stories: rankStories(lists, offsets), partial: failures.length > 0 },
      loadedAt,
    };
    return snapshot;
  }

  return async function getStories({ fresh = false, top = false } = {}) {
    const reuseMs = fresh ? WSJ_LIMITS.freshReuseMs : WSJ_LIMITS.reuseMs;
    const current = snapshot && Date.now() - snapshot.loadedAt < reuseMs
      ? snapshot
      : await (loading ??= load().finally(() => { loading = null; }));
    return top ? current.top : current.latest;
  };
}

module.exports = { WSJ_FEEDS, WSJ_LIMITS, articleURL, createWsjSource, mergeStories, parseFeed, rankStories };
