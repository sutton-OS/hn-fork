export function parseRoute() {
  const hash = window.location.hash.replace(/^#/, "").trim();

  if (!hash || hash === "/") {
    return { type: "list" };
  }

  const storyMatch = hash.match(/^\/(?:item|story)\/(\d+)$/);
  if (storyMatch) {
    return { type: "story", id: Number(storyMatch[1]) };
  }

  const queryStoryMatch = hash.match(/^\/item\?id=(\d+)$/);
  if (queryStoryMatch) {
    return { type: "story", id: Number(queryStoryMatch[1]) };
  }

  return { type: "list" };
}

export function navigateTo(pathname) {
  if (!pathname) {
    return;
  }

  const normalizedPath = pathname.startsWith("#")
    ? pathname.slice(1)
    : pathname.startsWith("/")
      ? pathname
      : `/${pathname}`;

  window.location.hash = normalizedPath;
}
