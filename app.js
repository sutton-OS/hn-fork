const API_BASE = "https://hacker-news.firebaseio.com/v0";
const PAGE_SIZE = 30;
const app = document.getElementById("app");

const store = {
  bestStoryIds: [],
};

const unescape = document.createElement("textarea");

window.addEventListener("popstate", render);
window.addEventListener("load", () => {
  normalizeLegacyHashRoute();
  render();
});
window.addEventListener("hashchange", () => {
  if (normalizeLegacyHashRoute()) {
    render();
  }
});

async function render() {
  const route = parseRoute();
  app.innerHTML = "";

  if (route.type === "story") {
    await renderStoryPage(route.id);
    return;
  }

  await renderListPage(route.page);
}

function parseRoute() {
  return parseRoutePath(window.location.pathname);
}

function parseRoutePath(rawPath) {
  const path = normalizePath(rawPath);

  if (path === "/") {
    return { type: "list", page: 1 };
  }

  const storyMatch = path.match(/^\/story\/(\d+)$/);
  if (storyMatch) {
    return { type: "story", id: Number(storyMatch[1]) };
  }

  const pageMatch = path.match(/^\/page\/(\d+)$/);
  if (pageMatch) {
    return { type: "list", page: Math.max(1, Number(pageMatch[1])) };
  }

  return { type: "list", page: 1 };
}

function normalizePath(rawPath) {
  const path = rawPath || "/";
  if (path === "/") {
    return "/";
  }
  return path.replace(/\/+$/, "") || "/";
}

function normalizeLegacyHashRoute() {
  if (!window.location.hash.startsWith("#/")) {
    return false;
  }
  const hashPath = normalizePath(window.location.hash.slice(1));
  const currentPath = normalizePath(window.location.pathname);
  if (hashPath === currentPath) {
    window.history.replaceState({}, "", hashPath);
    return false;
  }
  window.history.replaceState({}, "", hashPath);
  return true;
}

function navigateTo(path) {
  const nextPath = normalizePath(path);
  if (normalizePath(window.location.pathname) === nextPath) {
    return;
  }
  window.history.pushState({}, "", nextPath);
  render();
}

function escapeHTML(value) {
  unescape.textContent = value ?? "";
  return unescape.innerHTML;
}

async function fetchJSON(path) {
  const response = await fetch(`${API_BASE}/${path}`);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

async function getBestStoryIds() {
  if (store.bestStoryIds.length) {
    return store.bestStoryIds;
  }
  const ids = await fetchJSON("beststories.json");
  store.bestStoryIds = Array.isArray(ids) ? ids : [];
  return store.bestStoryIds;
}

async function getItems(ids) {
  return Promise.all(ids.map((id) => fetchJSON(`item/${id}.json`)));
}

function getDomain(url) {
  if (!url) {
    return "";
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function getSafeUrl(url) {
  if (!url) {
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

function topbar(content) {
  return `
    <header class="topbar">
      <a class="brand" href="/" data-nav>hn fork</a>
      ${content ?? ""}
    </header>
  `;
}

async function renderListPage(page) {
  try {
    app.innerHTML = `${topbar('<span class="status">loading stories...</span>')}`;
    const ids = await getBestStoryIds();
    const totalPages = Math.max(1, Math.ceil(ids.length / PAGE_SIZE));
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * PAGE_SIZE;
    const pageIds = ids.slice(start, start + PAGE_SIZE);
    const stories = await getItems(pageIds);

    app.innerHTML = `
      ${topbar(pager(safePage, totalPages))}
      <section class="story-list">
        ${stories.map((story, i) => renderStoryRow(story, start + i + 1)).join("")}
      </section>
    `;
    wirePagination();
  } catch (error) {
    app.innerHTML = `
      ${topbar("")}
      <p class="status">Could not load stories: ${escapeHTML(error.message)}</p>
    `;
  }
}

function pager(page, totalPages) {
  return `
    <nav class="pager" aria-label="Pagination">
      <button class="btn" ${page <= 1 ? "disabled" : ""} data-page="${page - 1}">prev</button>
      <span>${page}/${totalPages}</span>
      <button class="btn" ${page >= totalPages ? "disabled" : ""} data-page="${page + 1}">next</button>
    </nav>
  `;
}

function renderStoryRow(story, index) {
  if (!story) {
    return "";
  }

  const domain = getDomain(story.url);
  const safeUrl = getSafeUrl(story.url);
  const titleLink = `/story/${story.id}`;

  return `
    <article class="story">
      <div class="story-title">
        <a href="${titleLink}" data-nav>${index}. ${escapeHTML(story.title || "Untitled")}</a>
        ${domain ? `<span class="domain">(${escapeHTML(domain)})</span>` : ""}
      </div>
      <div class="story-meta">
        <span>${story.score ?? 0} points</span>
        <span>by ${escapeHTML(story.by || "unknown")}</span>
        <span>${timeAgo(story.time)} ago</span>
        ${safeUrl ? `<span><a href="${escapeHTML(safeUrl)}" target="_blank" rel="noopener noreferrer">open</a></span>` : ""}
      </div>
    </article>
  `;
}

async function renderStoryPage(id) {
  try {
    app.innerHTML = `${topbar('<span class="status">loading story...</span>')}`;
    const story = await fetchJSON(`item/${id}.json`);
    if (!story || story.type !== "story") {
      app.innerHTML = `
        ${topbar("")}
        <p class="status">Story not found.</p>
      `;
      return;
    }

    const safeUrl = getSafeUrl(story.url);
    app.innerHTML = `
      ${topbar('<a href="/" data-nav>back to list</a>')}
      <article>
        <h1 class="story-page-title">${escapeHTML(story.title || "Untitled")}</h1>
        <div class="story-page-meta">
          <span>${story.score ?? 0} points</span>
          <span>by ${escapeHTML(story.by || "unknown")}</span>
          <span>${timeAgo(story.time)} ago</span>
          ${safeUrl ? `<span><a href="${escapeHTML(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHTML(getDomain(safeUrl) || "link")}</a></span>` : ""}
        </div>
        ${story.text ? `<div class="story-text">${story.text}</div>` : ""}
      </article>
    `;
    wirePagination();
  } catch (error) {
    app.innerHTML = `
      ${topbar('<a href="/" data-nav>back to list</a>')}
      <p class="status">Could not load story: ${escapeHTML(error.message)}</p>
    `;
  }
}

function wirePagination() {
  app.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      const page = button.getAttribute("data-page");
      if (!page) return;
      navigateTo(`/page/${page}`);
    });
  });
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-nav]");
  if (link instanceof HTMLAnchorElement) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    const url = new URL(link.href);
    navigateTo(url.pathname);
    return;
  }

  const button = event.target.closest("[data-page]");
  if (button) {
    event.preventDefault();
  }
});
