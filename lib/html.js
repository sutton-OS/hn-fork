const { extractDomain } = require("./hn");

const FEED_LABELS = { best: "Best", top: "Top", new: "New" };
const VALID_FEEDS = new Set(["best", "top", "new"]);

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getSafeUrl(url) {
  if (!url || typeof url !== "string") {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Conservative HN HTML sanitizer for server-rendered pages (no DOM).
 * Allowlist tags; links must be http(s); drop all other attributes.
 */
function sanitizeHNHTML(value) {
  if (!value || typeof value !== "string") {
    return "";
  }

  const allowed = new Set([
    "a",
    "b",
    "blockquote",
    "br",
    "code",
    "em",
    "i",
    "li",
    "ol",
    "p",
    "pre",
    "span",
    "strong",
    "ul",
  ]);

  let html = value
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
    .replace(/<\/?(?:iframe|object|embed|form|input|button|textarea|select|meta|link)[^>]*>/gi, "");

  // Opening/self-closing tags
  html = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, rawTag, attrs) => {
    const isClose = match.startsWith("</");
    const tag = String(rawTag).toLowerCase();
    if (!allowed.has(tag)) {
      return "";
    }
    if (isClose) {
      return `</${tag}>`;
    }
    if (tag === "br") {
      return "<br>";
    }
    if (tag === "a") {
      const hrefMatch = attrs.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const rawHref = hrefMatch
        ? hrefMatch[2] || hrefMatch[3] || hrefMatch[4] || ""
        : "";
      const safe = getSafeUrl(rawHref.trim());
      if (!safe) {
        // Drop the tag; keep link text. Orphan </a> is ignored by browsers.
        return "";
      }
      return `<a href="${escapeHTML(safe)}" rel="noopener noreferrer" target="_blank">`;
    }
    return `<${tag}>`;
  });

  return html;
}

function timeAgo(unixSeconds) {
  const deltaSeconds = Math.max(
    0,
    Math.floor(Date.now() / 1000) - (unixSeconds || 0),
  );
  if (deltaSeconds < 60) return `${deltaSeconds}s`;
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

function normalizeFeed(feed) {
  const value = String(feed || "best").trim().toLowerCase();
  return VALID_FEEDS.has(value) ? value : "best";
}

function normalizeTheme(theme) {
  return theme === "light" ? "light" : "dark";
}

function themeQuery(theme) {
  return normalizeTheme(theme) === "light" ? "theme=light" : "theme=dark";
}

/** Append or replace theme on a relative path (may already have query). */
function withTheme(path, theme) {
  const t = themeQuery(theme);
  if (!path) {
    return `?${t}`;
  }
  if (path.includes("theme=")) {
    return path.replace(/theme=(light|dark)/, t);
  }
  return path.includes("?") ? `${path}&${t}` : `${path}?${t}`;
}

function plainFeedPath(feed, theme, { offset = 0 } = {}) {
  const f = normalizeFeed(feed);
  let path = `/plain/${f}`;
  if (offset > 0) {
    path += `?offset=${offset}`;
  }
  return withTheme(path, theme);
}

function plainItemPath(id, theme, { offset = 0 } = {}) {
  let path = `/plain/item/${Number(id)}`;
  if (offset > 0) {
    path += `?offset=${offset}`;
  }
  return withTheme(path, theme);
}

function renderFeedPicker(activeFeed, theme) {
  return ["best", "top", "new"]
    .map((feed) => {
      const active = feed === activeFeed ? " is-active" : "";
      const href = escapeHTML(plainFeedPath(feed, theme));
      const label = FEED_LABELS[feed];
      return `<a class="feed-option${active}" href="${href}"><span class="feed-option-label">${label}</span></a>`;
    })
    .join("");
}

function renderThemeLinks(theme, currentPath) {
  const lightHref = escapeHTML(withTheme(currentPath, "light"));
  const darkHref = escapeHTML(withTheme(currentPath, "dark"));
  const isLight = normalizeTheme(theme) === "light";
  return `
    <span class="plain-theme" role="group" aria-label="Color theme">
      <a class="plain-theme-link${isLight ? " is-active" : ""}" href="${lightHref}">Light</a>
      <span class="plain-theme-sep" aria-hidden="true">/</span>
      <a class="plain-theme-link${!isLight ? " is-active" : ""}" href="${darkHref}">Dark</a>
    </span>
  `;
}

function renderLayout({
  title,
  theme,
  body,
  description = "HNx plain HTML reader — works without JavaScript.",
}) {
  const t = normalizeTheme(theme);
  const themeColor = t === "dark" ? "#111111" : "#f3efe8";
  const safeTitle = escapeHTML(title || "HNx");

  return `<!doctype html>
<html lang="en" data-theme="${t}" style="color-scheme: ${t}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="referrer" content="no-referrer" />
    <meta name="theme-color" content="${themeColor}" />
    <meta name="description" content="${escapeHTML(description)}" />
    <title>${safeTitle}</title>
    <link rel="icon" type="image/png" href="/favicon.png?v=2" />
    <link rel="stylesheet" href="/styles.css?v=30" />
  </head>
  <body class="plain-page">
    <main class="app shell">
      ${body}
    </main>
    <a class="privacy-fab" href="/privacy.html">Privacy</a>
  </body>
</html>`;
}

function sendHTML(res, status, html) {
  res.status(status);
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.send(html);
}

function storyListArticle(story, theme) {
  const id = Number(story.id);
  const title = escapeHTML(story.title || "Untitled");
  const domain = story.domain || extractDomain(story.url) || "";
  const safeUrl = getSafeUrl(story.url);
  const itemHref = escapeHTML(plainItemPath(id, theme));
  const titleHtml = safeUrl
    ? `<a href="${escapeHTML(safeUrl)}" target="_blank" rel="noopener noreferrer">${title}</a>`
    : `<a href="${itemHref}">${title}</a>`;
  const domainHtml = domain
    ? `<span class="domain">(${escapeHTML(domain)})</span>`
    : "";

  return `
    <article class="story">
      <div class="story-title">
        ${titleHtml}
        ${domainHtml}
      </div>
      <div class="story-meta">
        <a class="meta-time" href="${itemHref}">${escapeHTML(timeAgo(story.time))} ago · comments</a>
      </div>
    </article>
  `;
}

function renderComment(comment, theme) {
  const id = Number(comment.id);
  const by = escapeHTML(comment.by || "unknown");
  const when = comment.time ? `${timeAgo(comment.time)} ago` : "";
  let body;
  if (comment.deleted) {
    body = "[deleted]";
  } else if (comment.dead) {
    body = "[dead]";
  } else if (comment.text) {
    body = sanitizeHNHTML(comment.text);
  } else {
    body = "[no text]";
  }

  const replyCount = Number(comment.replyCount) || 0;
  const replies =
    replyCount > 0
      ? `<a class="comment-replies-btn" href="${escapeHTML(plainItemPath(id, theme))}">${
          replyCount === 1 ? "1 reply" : `${replyCount} replies`
        }</a>`
      : "";

  return `
    <article class="comment">
      <div class="comment-header">
        <div class="comment-meta">
          <span class="meta-user">${by}</span>
          ${when ? `<span class="meta-time">${escapeHTML(when)}</span>` : ""}
        </div>
        ${replies}
      </div>
      <div class="comment-text">${body}</div>
    </article>
  `;
}

module.exports = {
  FEED_LABELS,
  VALID_FEEDS,
  escapeHTML,
  getSafeUrl,
  sanitizeHNHTML,
  timeAgo,
  normalizeFeed,
  normalizeTheme,
  withTheme,
  plainFeedPath,
  plainItemPath,
  renderFeedPicker,
  renderThemeLinks,
  renderLayout,
  sendHTML,
  storyListArticle,
  renderComment,
  extractDomain,
};
