import { getItem } from "./api.js?v=37";
import { createTaskQueue, getDomain, getSafeUrl } from "./utils.js";
import { bookmarkMetadata, createSavedStore } from "./saved-store.js";

const PREFIX = "hnx-saved-fallback:";
const PERSIST_KEY = "hnx-saved-persist-requested";
const CAP = 200;
const NO_COPY = "no-offline-copy";

function downloadError(error) {
  return error?.name === "QuotaExceededError"
    ? "Storage is full. The bookmark is kept without an offline copy."
    : "";
}

function readFallbacks() {
  const items = [];
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(PREFIX)) continue;
      const record = JSON.parse(localStorage.getItem(key));
      if (record && Number.isSafeInteger(record.id)) items.push(record);
    }
  } catch {
    // Saving can still work in memory when browser storage is blocked.
  }
  return items;
}

function deleteFallback(id) {
  try {
    localStorage.removeItem(PREFIX + id);
  } catch {
    // The IndexedDB record has its own lifecycle.
  }
}

function estimate() {
  return Promise.resolve().then(() => navigator.storage?.estimate?.()).catch(() => null);
}

export function createSavedStories() {
  const store = createSavedStore();
  const records = new Map();
  const downloads = new Map();
  const removals = new Set();
  const fallbackIds = new Set();
  const events = new EventTarget();
  const queueDownload = createTaskQueue(2);
  let pendingWrites = Promise.resolve();
  let persistenceRequested = false;
  let storeAvailable = true;
  let clearing = false;

  function emit(id) {
    events.dispatchEvent(new CustomEvent("change", { detail: id }));
  }

  function notify(message, undo) {
    events.dispatchEvent(new CustomEvent("notice", { detail: { message, undo } }));
  }

  function scheduleWrite(task) {
    const write = pendingWrites.then(task);
    pendingWrites = write.catch(() => {});
    return write;
  }

  function requestPersistence() {
    if (persistenceRequested) return;
    persistenceRequested = true;
    try {
      if (localStorage.getItem(PERSIST_KEY)) return;
      localStorage.setItem(PERSIST_KEY, "true");
    } catch {
      // Browsers can block localStorage while providing IndexedDB.
    }
    void Promise.resolve().then(() => navigator.storage?.persist?.()).catch(() => {});
  }

  const ready = (async () => {
    try {
      for (const record of await store.list()) records.set(record.id, record);
    } catch {
      storeAvailable = false;
    }
    for (const record of readFallbacks()) {
      if (!records.has(record.id)) {
        records.set(record.id, record);
        fallbackIds.add(record.id);
      }
    }
    emit();
  })();

  const latest = (record) => records.get(record.id)?.saveToken === record.saveToken;
  const status = (item) => item?.status === "pending" && !downloads.has(item.id) ? NO_COPY : item?.status;

  function fallback(record, error) {
    if (!latest(record)) return "";
    const bookmark = { ...record, status: NO_COPY, html: "", textLength: 0 };
    const full = error?.name === "QuotaExceededError";
    records.set(record.id, bookmarkMetadata(bookmark));
    fallbackIds.add(record.id);
    emit(record.id);
    try {
      localStorage.setItem(PREFIX + record.id, JSON.stringify(bookmark));
      return full ? downloadError(error) : "Bookmark saved. Offline article storage is unavailable.";
    } catch {
      return full
        ? "Storage is full. The bookmark is available until this tab closes."
        : "Storage is unavailable. The bookmark is available until this tab closes.";
    }
  }

  async function fetchArticle(record, signal) {
    const { sanitizeArticleHTML, sanitizeHNHTML } = await import("./sanitize.js?v=37");
    if (!record.url) {
      const item = await getItem(record.id, { signal });
      const html = sanitizeHNHTML(item?.text);
      const template = document.createElement("template");
      template.innerHTML = html;
      const textLength = template.content.textContent.trim().length;
      if (!textLength) throw new Error("This HN story has no text.");
      return { html, textLength, byline: item.by || "", siteName: "Hacker News", images: [] };
    }

    const response = await fetch(`/api/reader?${new URLSearchParams({ url: record.url })}`, {
      signal, credentials: "omit",
    });
    if (!response.ok) throw new Error("Could not extract the article.");
    const article = await response.json();
    if (typeof article.html !== "string" || !Number.isFinite(article.textLength) || article.textLength < 100) {
      throw new Error("The article is too short.");
    }

    const content = sanitizeArticleHTML(article.html);
    const images = (await Promise.all(Array.from(content.querySelectorAll("img"), async (node, index) => {
      const source = index < 8 && getSafeUrl(node.getAttribute("src"));
      node.removeAttribute("src");
      if (source) {
        try {
          const image = await fetch(`/api/image?${new URLSearchParams({ url: source })}`, {
            signal, credentials: "omit",
          });
          if (image.ok && /^image\//i.test(image.headers.get("content-type") || "")) {
            const blob = await image.blob();
            if (blob.size && blob.size <= 2 * 1024 * 1024) {
              node.dataset.savedImage = String(index);
              return { key: [record.id, index], blob, mime: blob.type };
            }
          }
        } catch {
          // A missing image does not prevent saving the article.
        }
      }
      node.remove();
      return null;
    }))).filter(Boolean);
    const template = document.createElement("template");
    template.content.append(content);
    return {
      html: template.innerHTML,
      textLength: article.textLength,
      byline: typeof article.byline === "string" ? article.byline : "",
      siteName: typeof article.siteName === "string" ? article.siteName : "",
      images,
    };
  }

  function startDownload(record, written) {
    const controller = new AbortController();
    downloads.set(record.id, controller);
    void written.then(async (ok) => {
      if (!ok || !latest(record) || controller.signal.aborted) return;
      let copy;
      let images;
      try {
        const article = await queueDownload(() => {
          if (!navigator.onLine) throw new Error("Offline");
          controller.signal.throwIfAborted();
          return fetchArticle(record, controller.signal);
        });
        ({ images, ...copy } = article);
      } catch {
        // A failed extraction leaves the bookmark in the list.
      }
      await scheduleWrite(async () => {
        if (!latest(record) || controller.signal.aborted) return;
        let updated = copy
          ? { ...record, ...copy, status: "ready" }
          : { ...record, status: NO_COPY };
        try {
          if (!await store.finish(updated, images)) {
            records.delete(record.id);
          } else {
            records.set(record.id, bookmarkMetadata(updated));
          }
        } catch (error) {
          updated = { ...record, status: NO_COPY };
          records.set(record.id, bookmarkMetadata(updated));
          // An aborted content transaction leaves the small pending record intact.
          try {
            await store.finish(updated);
          } catch {
            // An interrupted pending record is shown as retryable on next launch.
          }
          notify(downloadError(error) || "The bookmark is kept without an offline copy.");
        }
        emit(record.id);
      });
    }).catch(() => {}).finally(() => {
      if (downloads.get(record.id) === controller) downloads.delete(record.id);
    });
  }

  function writeBookmark(record, { retrying = false } = {}) {
    const written = scheduleWrite(async () => {
      let message = "Saved";
      let ok = false;
      try {
        if (retrying && !fallbackIds.has(record.id)) {
          if (!await store.finish(record)) {
            if (latest(record)) {
              records.delete(record.id);
              emit(record.id);
            }
            return false;
          }
        } else {
          await store.put(record);
        }
        storeAvailable = true;
        fallbackIds.delete(record.id);
        deleteFallback(record.id);
        ok = true;
      } catch (error) {
        message = fallback(record, error);
      }
      if (message && latest(record) && !removals.has(record.id) && (!retrying || !ok)) {
        notify(message, retrying ? undefined : () => remove(record.id, record.saveToken));
      }
      return ok;
    });

    records.set(record.id, bookmarkMetadata(record));
    startDownload(record, written);
    emit(record.id);
  }

  function save(story) {
    const id = Number(story.id);
    if (!Number.isSafeInteger(id) || id <= 0 || records.has(id)) return;
    if (records.size >= CAP && !window.confirm(`You have ${records.size} saved stories. Save another?`)) return;

    requestPersistence();
    const url = getSafeUrl(story.url) || "";
    writeBookmark({
      id, title: story.title || "Untitled", url, domain: story.domain || getDomain(url) || "news.ycombinator.com",
      points: story.points ?? story.score ?? null, comments: story.comments ?? story.descendants ?? null,
      hnTime: story.hnTime ?? story.time ?? 0, savedAt: Date.now(), saveToken: crypto.randomUUID(),
      status: "pending", byline: "", siteName: "", html: "", textLength: 0,
    });
  }

  function remove(id, saveToken) {
    const previous = records.get(id);
    if (!previous || removals.has(id) || (saveToken && previous.saveToken !== saveToken)) return;
    removals.add(id);
    downloads.get(id)?.abort();
    downloads.delete(id);
    void scheduleWrite(async () => {
      try {
        if (storeAvailable && !fallbackIds.has(id)) await store.remove(id, previous.saveToken);
        fallbackIds.delete(id);
        deleteFallback(id);
        if (latest(previous)) records.delete(id);
      } catch {
        notify("Could not remove this bookmark. Try again.");
      } finally {
        removals.delete(id);
        emit(id);
      }
    });
  }

  function retry(id) {
    const record = records.get(id);
    if (status(record) !== NO_COPY || !navigator.onLine || removals.has(id) || clearing) return;
    writeBookmark({ ...record, status: "pending", html: "" }, { retrying: true });
  }

  function clear() {
    if (clearing || !records.size || !window.confirm("Clear all saved stories and offline copies?")) return;
    clearing = true;
    const previous = [...records.values()];
    for (const controller of downloads.values()) controller.abort();
    downloads.clear();
    void scheduleWrite(async () => {
      try {
        if (storeAvailable) await store.clear();
        for (const record of previous) {
          fallbackIds.delete(record.id);
          deleteFallback(record.id);
        }
        for (const record of previous) {
          if (latest(record)) records.delete(record.id);
        }
      } catch {
        notify("Could not clear saved stories. Try again.");
      } finally {
        clearing = false;
        emit();
      }
    });
  }

  async function read(id) {
    try {
      const data = await store.read(id);
      if (data.record && latest(data.record)) return data;
    } catch {
      // The bookmark still has an external link when its copy is inaccessible.
    }
    return null;
  }

  return {
    events, ready, get: (id) => records.get(id), count: () => records.size,
    list: () => [...records.values()].sort((a, b) => b.savedAt - a.savedAt || b.id - a.id),
    status, save, remove, retry, clear, read, estimate, notify,
  };
}
