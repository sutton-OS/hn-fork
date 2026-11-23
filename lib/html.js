// Bundle ESM transitive dependencies for serverless CommonJS loaders.
const sanitizeHtml = require("./vendor/sanitize-html.cjs");
const { extractDomain, normalizeFeed: normalizeFeedName, setDataCacheHeaders } = require("./hn");

const FEED_LABELS = { best: "Best", top: "Top", new: "New" };

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeBasicEntities(value) {
  return String(value ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2f;/gi, "/")
    .replace(/&#0*47;/g, "/");
}

function getSafeUrl(url) {
  if (!url || typeof url !== "string") {
    return null;
  }
  try {
    const parsed = new URL(decodeBasicEntities(url).trim());
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

/** Parse and sanitize HN fragments before embedding them in a document. */
function sanitizeHNHTML(value) {
  if (typeof value !== "string") return "";
  return sanitizeHtml(value, {
    allowedTags: [
      "a", "b", "blockquote", "br", "code", "em", "i", "li",
      "ol", "p", "pre", "span", "strong", "ul",
    ],
    allowedAttributes: { a: ["href", "rel", "target"] },
    allowedSchemes: ["http", "https"],
    allowProtocolRelative: false,
    parseStyleAttributes: false,
    transformTags: {
      a(tagName, attributes) {
        const href = getSafeUrl(attributes.href);
        return {
          tagName,
          attribs: href ? { href, rel: "noopener noreferrer", target: "_blank" } : {},
        };
      },
    },
  });
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
  return normalizeFeedName(feed);
}

function normalizeTheme(theme) {
  return theme === "light" ? "light" : "dark";
}

/** "classic" = 90s bare HTML skin; anything else is the modern plain reader. */
function normalizeSkin(skin) {
  return skin === "classic" ? "classic" : "plain";
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

function classicFeedPath(feed, { offset = 0 } = {}) {
  const f = normalizeFeed(feed);
  let path = `/classic/${f}`;
  if (offset > 0) {
    path += `?offset=${offset}`;
  }
  return path;
}

function classicItemPath(id, { offset = 0 } = {}) {
  let path = `/classic/item/${Number(id)}`;
  if (offset > 0) {
    path += `?offset=${offset}`;
  }
  return path;
}

function renderFeedPicker(activeFeed, theme) {
  return ["best", "top", "new"]
    .map((feed) => {
      const active = feed === activeFeed ? " is-active" : "";
      const href = escapeHTML(plainFeedPath(feed, theme));
      const label = FEED_LABELS[feed];
      return `<a class="feed-option${active}" href="${href}"${active ? ' aria-current="page"' : ""}>${label}</a>`;
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
  const themeColor = t === "dark" ? "#121212" : "#f8f7f4";
  const safeTitle = escapeHTML(title || "HNx");

  return `<!doctype html>
<html lang="en" data-theme="${t}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="referrer" content="no-referrer" />
    <meta name="theme-color" content="${themeColor}" />
    <meta name="description" content="${escapeHTML(description)}" />
    <title>${safeTitle}</title>
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png?v=2" />
    <link rel="preload" href="/fonts/Geist-1.9.2-Variable.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="preload" href="/fonts/GeistMono-1.9.2-Variable.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="stylesheet" href="/styles.css?v=36" />
  </head>
  <body class="plain-page">
    <main class="app shell">
      ${body}
    </main>
    <footer class="site-footer"><a href="/privacy.html">Privacy</a></footer>
  </body>
</html>`;
}

/**
 * Bare-bones 90s layout: browser defaults, blue links, no panels/fonts/chrome.
 */
function renderClassicLayout({
  title,
  body,
  description = "HNx classic HTML mode — blue links, no fanciness.",
}) {
  const safeTitle = escapeHTML(title || "HNx");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="referrer" content="no-referrer" />
    <meta name="description" content="${escapeHTML(description)}" />
    <title>${safeTitle}</title>
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png?v=2" />
    <link rel="stylesheet" href="/classic.css?v=1" />
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

function renderClassicNav(activeFeed) {
  const feeds = ["best", "top", "new"]
    .map((feed) => {
      const href = escapeHTML(classicFeedPath(feed));
      const label = feed;
      if (feed === activeFeed) {
        return `<b>${label}</b>`;
      }
      return `<a href="${href}">${label}</a>`;
    })
    .join(" | ");
  return `<p>
  <b><a href="${escapeHTML(classicFeedPath("best"))}">HNx</a></b>
  | ${feeds}
  | <a href="/">modern UI</a>
  | <a href="/plain">plain</a>
  | <a href="/privacy.html">privacy</a>
</p>
<hr>`;
}

function classicStoryListItem(story) {
  const id = Number(story.id);
  const title = escapeHTML(story.title || "Untitled");
  const domain = story.domain || extractDomain(story.url) || "";
  const safeUrl = getSafeUrl(story.url);
  const itemHref = escapeHTML(classicItemPath(id));
  const titleHtml = safeUrl
    ? `<a href="${escapeHTML(safeUrl)}">${title}</a>`
    : `<a href="${itemHref}">${title}</a>`;
  const domainHtml = domain ? ` (${escapeHTML(domain)})` : "";
  const when = story.time ? `${timeAgo(story.time)} ago` : "";

  return `<li>
  ${titleHtml}${domainHtml}<br>
  <small>${when ? `${escapeHTML(when)} · ` : ""}<a href="${itemHref}">comments</a></small>
</li>`;
}

function classicCommentItem(comment) {
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
      ? ` | <a href="${escapeHTML(classicItemPath(id))}">${
          replyCount === 1 ? "1 reply" : `${replyCount} replies`
        }</a>`
      : "";

  return `<div class="c">
  <p class="cm"><b>${by}</b>${when ? ` · ${escapeHTML(when)}` : ""}${replies}</p>
  <div class="ct">${body}</div>
</div>`;
}

function sendHTML(res, status, html, { cacheFeed = false } = {}) {
  res.status(status);
  res.setHeader("content-type", "text/html; charset=utf-8");
  setDataCacheHeaders(res, status === 200 && cacheFeed);
  res.send(html);
}

function renderStoryListItem(story, theme) {
  const id = Number(story.id);
  const title = escapeHTML(story.title || "Untitled");
  const domain = (story.domain || extractDomain(story.url) || "news.ycombinator.com").toLowerCase();
  const safeUrl = getSafeUrl(story.url);
  const itemHref = escapeHTML(plainItemPath(id, theme));
  const titleHtml = safeUrl
    ? `<a href="${escapeHTML(safeUrl)}" target="_blank" rel="noopener noreferrer">${title}</a>`
    : `<a href="${itemHref}">${title}</a>`;
  const age = escapeHTML(`${timeAgo(story.time)} ago`);

  return `
    <li class="story">
      <div class="story-title">${titleHtml}</div>
      <div class="story-meta">
        <span class="story-source"><span class="domain">${escapeHTML(domain)}</span></span>
        <span class="meta-part"><span class="meta-divider" aria-hidden="true">·</span> ${age}</span>
        <span class="meta-part">
          <span class="meta-divider" aria-hidden="true">·</span>
          <a class="story-comments-link" href="${itemHref}" aria-label="comments on ${title}">comments</a>
        </span>
      </div>
    </li>
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
  escapeHTML,
  getSafeUrl,
  sanitizeHNHTML,
  timeAgo,
  normalizeFeed,
  normalizeTheme,
  normalizeSkin,
  withTheme,
  plainFeedPath,
  plainItemPath,
  classicFeedPath,
  classicItemPath,
  renderFeedPicker,
  renderThemeLinks,
  renderLayout,
  renderClassicLayout,
  renderClassicNav,
  classicStoryListItem,
  classicCommentItem,
  sendHTML,
  renderStoryListItem,
  renderComment,
  extractDomain,
};
