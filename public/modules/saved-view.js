import { escapeHTML, getSafeUrl } from "./utils.js";

const BOOKMARK = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24"
  stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none">
  <path d="M6 4h12v16l-6-4-6 4z"/>
</svg>`;
const OVERFLOW = `<svg aria-hidden="true" fill="currentColor" width="18" height="18" viewBox="0 0 24 24">
  <circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>
</svg>`;

export function createSavedView(saved) {
  const dialog = document.querySelector("[data-reader]");
  const body = dialog.querySelector("[data-reader-content]");
  const heading = dialog.querySelector("[data-reader-title]");
  const readerSave = dialog.querySelector("[data-reader-save]");
  const close = dialog.querySelector("[data-reader-close]");
  const toast = document.querySelector("[data-save-toast]");
  const toastHome = toast.parentElement;
  const notice = toast.querySelector("[role=status]");
  const undoButton = toast.querySelector("[data-save-undo]");
  const objectUrls = [];
  let openedStory;
  let readerTrigger;
  let readerVersion = 0;
  let displayedCopy;
  let toastTimer;
  let undoTimer;
  let undo;
  let undoTrigger;

  function bookmark(id) {
    const item = saved.get(id);
    return `<button class="save-icon" type="button" data-bookmark
      aria-pressed="${Boolean(item)}" aria-label="Save for later">${BOOKMARK}</button>`;
  }

  function overflow(title) {
    return `<details class="saved-overflow">
      <summary class="save-icon" aria-label="Options for ${escapeHTML(title)}">${OVERFLOW}</summary>
      <div class="saved-menu"><button type="button" data-remove-saved>Remove</button></div>
    </details>`;
  }

  function updateRow(row) {
    const id = Number(row.dataset.storyId);
    const record = saved.get(id);
    const status = saved.status(record);
    const button = row.querySelector("[data-bookmark]");
    button?.setAttribute("aria-pressed", String(Boolean(record)));
    const retry = row.querySelector("[data-retry-saved]");
    const pending = row.querySelector("[data-saving-copy]");
    if (retry) {
      retry.hidden = status !== "no-offline-copy";
      if (retry.hidden && document.activeElement === retry) button?.focus({ preventScroll: true });
      retry.disabled = !navigator.onLine;
      retry.textContent = navigator.onLine ? "No offline copy, retry" : "No offline copy. Retry when online.";
    }
    if (pending) pending.hidden = status !== "pending";
  }

  function rowStatus() {
    return `<p class="save-row-status status" data-saving-copy hidden>Saving offline copy…</p>
      <button class="btn save-row-status" type="button" data-retry-saved hidden>No offline copy, retry</button>`;
  }

  function toggle(story) {
    if (saved.get(story.id)) saved.remove(story.id);
    else saved.save(story);
  }

  function clearReader() {
    body.replaceChildren();
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.length = 0;
  }

  function renderFallback(story, status) {
    const href = getSafeUrl(story.url) || `https://news.ycombinator.com/item?id=${story.id}`;
    body.innerHTML = `
      <p class="status">${status === "pending" ? "Saving offline copy…" : "No offline copy available."}</p>
      <a class="btn" href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer"
        data-online-link>Open in browser</a>
    `;
  }

  async function paintReader() {
    if (!dialog.open || !openedStory) return;
    const story = openedStory;
    const item = saved.get(story.id);
    const status = saved.status(item);
    readerSave.setAttribute("aria-pressed", String(Boolean(item)));
    readerSave.textContent = item ? "Saved" : "Save";
    const copy = status === "ready" ? item.saveToken : status || "unsaved";
    if (copy === displayedCopy) return;
    displayedCopy = copy;
    const version = ++readerVersion;
    clearReader();
    dialog.scrollTop = 0;
    heading.textContent = story.title;
    if (status !== "ready") {
      renderFallback(story, status);
      return;
    }

    let data;
    let sanitizeArticleHTML;
    try {
      [data, { sanitizeArticleHTML }] = await Promise.all([saved.read(story.id), import("./sanitize.js?v=37")]);
    } catch {
      if (version === readerVersion && dialog.open) renderFallback(story);
      return;
    }
    if (version !== readerVersion || !dialog.open) return;
    if (!data?.record?.html) {
      renderFallback(story);
      return;
    }
    const { record, images } = data;
    const metadata = document.createElement("p");
    metadata.className = "status reader-meta";
    metadata.textContent = ["Saved offline", record.siteName, record.byline].filter(Boolean).join(" · ");
    const article = document.createElement("article");
    article.className = "reader-article story-text";
    const content = sanitizeArticleHTML(record.html, { stored: true });
    const blobs = new Map(images.map(({ key, blob }) => [String(key[1]), blob]));
    for (const image of content.querySelectorAll("img")) {
      const blob = blobs.get(image.dataset.savedImage);
      if (!blob) {
        image.remove();
        continue;
      }
      try {
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        image.src = url;
        image.decoding = "async";
      } catch {
        image.remove();
      }
    }
    for (const link of content.querySelectorAll("a[href]")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.dataset.onlineLink = "";
    }
    article.append(content);
    body.append(metadata, article);
  }

  function open(id, trigger) {
    const story = saved.get(id);
    if (!story || dialog.open) return;
    openedStory = story;
    readerTrigger = trigger;
    displayedCopy = undefined;
    heading.textContent = story.title;
    dialog.append(toast);
    dialog.showModal();
    void paintReader();
  }

  close.addEventListener("click", () => dialog.close());
  readerSave.addEventListener("click", () => {
    if (openedStory) toggle(openedStory);
  });
  dialog.addEventListener("close", () => {
    readerVersion += 1;
    clearReader();
    openedStory = null;
    toastHome.append(toast);
    const trigger = readerTrigger?.isConnected ? readerTrigger : document.querySelector("#feed-tab-saved");
    trigger?.focus({ preventScroll: true });
    readerTrigger = null;
  });
  saved.events.addEventListener("change", (event) => {
    if (!event.detail || event.detail === openedStory?.id) void paintReader();
  });

  function hideUndo() {
    if (document.activeElement === undoButton) {
      const fallback = dialog.open ? readerSave : document.querySelector('[role=tab][aria-selected=true]');
      (undoTrigger?.isConnected && (!dialog.open || dialog.contains(undoTrigger)) ? undoTrigger : fallback)
        ?.focus({ preventScroll: true });
    }
    undo = null;
    undoTrigger = null;
    undoButton.hidden = true;
  }

  function hideToast() {
    window.clearTimeout(undoTimer);
    hideUndo();
    notice.textContent = "";
    toast.classList.remove("is-visible");
  }

  saved.events.addEventListener("notice", (event) => {
    const { message, undo: action } = event.detail;
    if (action) {
      window.clearTimeout(undoTimer);
      undo = action;
      undoTrigger = document.activeElement;
      undoButton.hidden = false;
      undoTimer = window.setTimeout(hideUndo, 4000);
    }
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(hideToast, 4000);
    notice.textContent = message;
    toast.classList.add("is-visible");
  });
  undoButton.addEventListener("click", () => {
    undo?.();
    hideToast();
  });

  return { bookmark, overflow, rowStatus, updateRow, toggle, open, dialog };
}
