import { getItem } from "./api.js?v=41";
import { closeOpenSheet } from "./sheet.js";
import { getSafeUrl } from "./utils.js";

// Evaluate the live media query on every activation, including after rotation.
const mobile = matchMedia("(max-width: 768px) and (pointer: coarse)");
const filePath = /\.(?:pdf|epub|docx?|xlsx?|pptx?|csv|tsv|txt|xml|json|zip|gz|rar|7z|tar|bz2|xz|dmg|exe|apk|mp[34]|m4[av]|avi|wav|ogg|ogv|webm|mov|mkv|flac|m3u8|jpe?g|png|avif|webp|svg|gif|ico|bmp|tiff?)\/?$/i;
let opening = false;
let alertRequest;

function storyLink(id, url, title) {
  const link = document.createElement("a");
  link.href = url;
  link.textContent = title || "Hacker News story " + id;
  link.dataset.storyId = String(id);
  return link;
}

async function openAlertStory(app, id, { restore = false, beforeOpen } = {}) {
  alertRequest?.abort();
  const controller = new AbortController();
  alertRequest = controller;
  const { signal } = controller;
  try {
    const [{ openPreview }, item] = await Promise.all([
      import("./preview.js"),
      getItem(id, { signal }).catch(() => null),
    ]);
    if (signal.aborted || (restore && !history.state?.alertStory)) return;
    await closeOpenSheet();
    if (signal.aborted) return;
    const publisher = getSafeUrl(item?.url);
    const discussion = "https://news.ycombinator.com/item?id=" + id;
    const target = publisher ? new URL(publisher) : null;
    const hnOnly = !target || (target.hostname === "news.ycombinator.com" && target.pathname === "/item" &&
      target.searchParams.get("id") === String(id));
    const rowLink = app.querySelector('.story-title a[data-story-id="' + id + '"]');
    const link = storyLink(id, publisher || discussion, item?.title || rowLink?.textContent);
    beforeOpen?.();
    openPreview(link, restore, { hnOnly, text: item?.text, returnFocus: rowLink });
  } catch {
    if (signal.aborted) return;
    beforeOpen?.();
    location.hash = "/item/" + id;
  }
}

export function wireNotificationStories(app) {
  navigator.serviceWorker?.addEventListener("message", event => {
    const id = Number(event.data?.id);
    if (event.data?.type === "open-story" && Number.isSafeInteger(id) && id > 0 && id <= 999999999999) {
      void openAlertStory(app, id);
    }
  });
  const value = new URL(location.href).searchParams.get("story");
  if (value === null) return;
  const clean = () => {
    const url = new URL(location.href);
    url.searchParams.delete("story");
    history.replaceState(history.state, "", url);
  };
  if (/^\d{1,12}$/.test(value) && Number(value) > 0) {
    void openAlertStory(app, Number(value), { beforeOpen: clean });
  } else clean();
}

async function open(link, restore = false, fallback) {
  if (opening || document.querySelector(".preview-dialog")) return;
  opening = true;
  try {
    const { openPreview } = await import("./preview.js");
    if (restore ? isPublisherPreview(link.dataset.storyId) : link.isConnected && mobile.matches) {
      openPreview(link, restore, fallback);
    }
  } catch {
    // Keep the native destination accessible even if the module fails to load.
    if (link.isConnected) {
      link.dataset.previewBypass = "true";
      link.click();
      delete link.dataset.previewBypass;
    }
  } finally {
    opening = false;
  }
}

function isPublisherPreview(id) {
  const state = history.state;
  return state?.sheet && !state.alertStory && String(state.storyId) === String(id);
}

export function wirePreview(app) {
  app.addEventListener("click", event => {
    const link = event.target.closest('.story-list .story-title a[target="_blank"]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.shiftKey ||
        event.altKey || event.metaKey || !navigator.onLine || !mobile.matches || link.hasAttribute("download") || link.dataset.previewBypass) return;
    const url = new URL(link.href);
    if (!["http:", "https:"].includes(url.protocol) || url.origin === location.origin ||
        filePath.test(url.pathname) || url.searchParams.has("download")) return;
    event.preventDefault();
    void open(link);
  });

  async function restore() {
    const state = history.state;
    if (!state?.sheet || !/^\d{1,12}$/.test(String(state.storyId)) || Number(state.storyId) <= 0) return;
    const id = Number(state.storyId);
    if (state.alertStory) {
      void openAlertStory(app, id, { restore: true });
      return;
    }
    const row = app.querySelector('.story-list .story-title a[data-story-id="' + id + '"]');
    const item = state.publisher ?? (row?.target === "_blank"
      ? { url: row.href, title: row.textContent }
      : await getItem(id).catch(() => null));
    if (!isPublisherPreview(id)) return;
    const url = getSafeUrl(item?.url);
    if (url) {
      void open(row?.href === url ? row : storyLink(id, url, item.title), true);
    } else {
      const link = storyLink(id, "https://news.ycombinator.com/item?id=" + id, item?.title || row?.textContent);
      void open(link, true, { hnOnly: true, text: item?.text, returnFocus: row });
    }
  }
  window.addEventListener("popstate", restore);
  // Reloading or restoring a tab can start on an existing sheet history entry.
  if (history.state?.sheet && (!history.state.alertStory || !new URL(location.href).searchParams.has("story"))) {
    void restore();
  }
}
