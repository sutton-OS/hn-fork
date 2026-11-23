import { escapeHTML } from "./utils.js";
import { lockSheetScroll, wireSheetDrag } from "./sheet.js";

const externalIcon = '<path d="M13 5h6v6m0-6-9 9"/><path d="M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>';
const closeIcon = '<path d="m6 6 12 12M18 6 6 18"/>';
const icon = path => '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
const SITE_HEAD_START_MS = 2000;
const PREVIEW_TIMEOUT_MS = 8000;

async function query(endpoint, id, signal) {
  const request = new AbortController();
  const abort = () => request.abort();
  const timer = setTimeout(abort, PREVIEW_TIMEOUT_MS);
  signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch("/api/" + endpoint + "?id=" + encodeURIComponent(id), {
      credentials: "omit", signal: request.signal,
    });
    if (!response.ok) throw new Error("Preview unavailable");
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function decisionFor(id, url, signal) {
  const key = "hnx:preview:" + url.origin;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key));
    if (saved?.id === id && saved.href === url.href && saved.until > Date.now()) return saved.decision;
  } catch {}
  const decision = await query("embeddable", id, signal);
  if (decision.reason !== "publisher-status") {
    try { sessionStorage.setItem(key, JSON.stringify({ id, href: url.href, until: Date.now() + 86400000, decision })); } catch {}
  }
  return decision;
}

export function openPreview(link, restore, alertStory) {
  const url = new URL(link.href);
  const id = link.dataset.storyId;
  const title = link.textContent.trim();
  const dialog = document.createElement("dialog");
  dialog.className = alertStory ? "preview-dialog alert-story-dialog" : "preview-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", title);
  dialog.innerHTML = `
    <span class="preview-focus-start" tabindex="0"></span>
    <section class="preview-panel">
      <header class="preview-header">
        <span class="preview-source"><img width="16" height="16" alt="" hidden><span></span></span>
        <button type="button" class="preview-toggle" hidden></button>
        <a class="preview-external" target="_blank" rel="noopener noreferrer" aria-label="Open in browser" title="Open in browser">${icon(externalIcon)}</a>
        <button type="button" class="preview-close" aria-label="Close preview" autofocus>${icon(closeIcon)}</button>
      </header>
      <div class="preview-loading" role="progressbar" aria-label="Loading preview"></div>
      <div class="preview-content"></div>
    </section>
    <span class="preview-focus-end" tabindex="0"></span>`;
  const panel = dialog.querySelector(".preview-panel");
  const header = dialog.querySelector("header");
  const content = dialog.querySelector(".preview-content");
  const bar = dialog.querySelector(".preview-loading");
  const toggle = dialog.querySelector(".preview-toggle");
  const external = dialog.querySelector(".preview-external");
  const close = dialog.querySelector(".preview-close");
  external.href = url.href;
  header.querySelector(".preview-source span").textContent = url.hostname;
  const originalIcon = link.closest(".story")?.querySelector(".story-favicon");
  if (originalIcon && !originalIcon.hidden) {
    const img = header.querySelector("img");
    img.onload = () => { img.hidden = false; };
    img.referrerPolicy = "no-referrer";
    img.src = originalIcon.src;
  }

  const previousRestoration = history.scrollRestoration;
  history.scrollRestoration = "manual";
  if (!restore) {
    const story = alertStory ? { alertStory: true } : { publisher: { url: url.href, title } };
    history.pushState({ sheet: true, storyId: id, ...story }, "");
  }
  const unlockScroll = lockSheetScroll();
  document.body.append(dialog);
  dialog.showModal();
  close.focus({ preventScroll: true });
  requestAnimationFrame(() => requestAnimationFrame(() => dialog.classList.add("is-visible")));

  const controller = new AbortController();
  const { signal } = controller;
  let readerTimer;
  let frameTimer;
  let closing = false;
  let readerRequest;
  let article;
  let liveFrame;
  let siteReady = false;
  let readerNode;

  function dismiss(manual) {
    if (closing) return;
    closing = true;
    clearTimeout(readerTimer);
    clearTimeout(frameTimer);
    controller.abort();
    dialog.classList.add("is-closing");
    const animation = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220;
    let historyReady = !manual || !history.state?.sheet;
    let animationReady = false;
    function finish() {
      if (!animationReady || !historyReady) return;
      dialog.close();
      dialog.remove();
      history.scrollRestoration = previousRestoration;
      const originalLink = link.isConnected ? link
        : document.querySelector('.story-list .story-title a[data-story-id="' + CSS.escape(id) + '"]');
      (alertStory?.returnFocus ?? originalLink)?.focus({ preventScroll: true });
      unlockScroll();
    }
    if (!historyReady) {
      // Remove the child browsing context before traversing our own history.
      liveFrame?.remove();
      window.addEventListener("popstate", () => { historyReady = true; finish(); }, { once: true });
      history.back();
    }
    setTimeout(() => { animationReady = true; finish(); }, animation);
  }
  const manualClose = () => dismiss(true);
  close.onclick = manualClose;
  dialog.addEventListener("hnx-close-sheet", manualClose);
  dialog.oncancel = event => { event.preventDefault(); manualClose(); };
  dialog.onclick = event => { if (event.target === dialog) manualClose(); };
  window.addEventListener("popstate", () => dismiss(false), { signal });
  wireSheetDrag(header, panel, manualClose);
  function tabStops() {
    return [...panel.querySelectorAll("button, a[href], iframe, [tabindex='0']")]
      .filter(el => el.getClientRects().length);
  }
  // Focus guards also receive Tab when it exits the embedded page, whose
  // keyboard events cannot bubble across the publisher's document boundary.
  dialog.querySelector(".preview-focus-start").onfocus = () => tabStops().at(-1)?.focus();
  dialog.querySelector(".preview-focus-end").onfocus = () => tabStops()[0]?.focus();
  dialog.onkeydown = event => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); manualClose(); }
  };

  function fallback(message = "This article couldn’t be previewed.") {
    bar.hidden = true;
    toggle.hidden = true;
    content.innerHTML = '<div class="preview-fallback"><p role="status"></p><a target="_blank" rel="noopener noreferrer">Open in browser</a></div>';
    content.querySelector("p").textContent = message;
    content.querySelector("a").href = url.href;
  }

  function updateToggle() {
    toggle.hidden = !siteReady || !article;
    toggle.textContent = liveFrame?.hidden ? "Site" : "Reader";
    toggle.setAttribute("aria-label", "Switch to " + toggle.textContent);
  }

  function showReader() {
    if (!readerNode) {
      readerNode = document.createElement("article");
      readerNode.className = "preview-reader";
      readerNode.tabIndex = 0;
      // The reader API returns DOMPurify-allowlisted article markup.
      readerNode.innerHTML = '<h1>' + escapeHTML(article.title || title) + '</h1><p class="preview-byline">' +
        escapeHTML([article.byline, article.siteName].filter(Boolean).join(" · ")) + '</p>' + article.html;
      content.append(readerNode);
    }
    if (liveFrame) liveFrame.hidden = true;
    readerNode.hidden = false;
    bar.hidden = true;
    updateToggle();
  }

  async function readerOrFallback() {
    clearTimeout(readerTimer);
    clearTimeout(frameTimer);
    liveFrame?.remove();
    liveFrame = null;
    siteReady = false;
    await readerRequest;
    if (signal.aborted) return;
    if (article) showReader();
    else fallback();
  }

  function showSite(finalUrl) {
    const frame = document.createElement("iframe");
    liveFrame = frame;
    frame.title = title;
    frame.loading = "eager";
    frame.hidden = Boolean(readerNode);
    frame.referrerPolicy = "no-referrer";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox");
    frame.src = finalUrl;
    frameTimer = setTimeout(readerOrFallback, PREVIEW_TIMEOUT_MS);
    frame.onerror = () => { if (!signal.aborted && liveFrame === frame) void readerOrFallback(); };
    frame.onload = async () => {
      if (signal.aborted || liveFrame !== frame) return;
      siteReady = true;
      clearTimeout(readerTimer);
      clearTimeout(frameTimer);
      bar.hidden = true;
      await readerRequest;
      if (!signal.aborted && liveFrame === frame) updateToggle();
    };
    content.append(frame);
  }
  toggle.onclick = () => {
    if (!liveFrame.hidden) return showReader();
    readerNode.hidden = true;
    liveFrame.hidden = false;
    updateToggle();
  };

  async function load() {
    let decision;
    readerRequest = query("reader", id, signal).then(result => { article = result; }, () => {});
    readerTimer = setTimeout(async () => {
      // Keep fast sites first and let the article take over if the site stalls.
      await readerRequest;
      if (article && !signal.aborted && !siteReady && decision?.reason !== "non-html") showReader();
    }, SITE_HEAD_START_MS);
    try { decision = await decisionFor(id, url, signal); } catch {}
    if (signal.aborted) return;
    if (decision?.reason === "non-html") {
      clearTimeout(readerTimer);
      // Extensionless downloads are identifiable only after the asynchronous probe.
      const tab = window.open("about:blank", "_blank");
      if (tab) {
        tab.opener = null;
        tab.location.replace(url.href);
        manualClose();
      } else fallback("Open this file in your browser.");
    } else if (decision?.embeddable) {
      const target = new URL(decision.finalUrl || url.href);
      if (target.origin !== location.origin && ["https:", "http:"].includes(target.protocol)) {
        target.hash ||= url.hash;
        showSite(target.href);
      } else await readerOrFallback();
    } else await readerOrFallback();
  }
  if (alertStory) {
    const discussion = document.createElement("a");
    discussion.href = "#/item/" + id;
    discussion.className = "preview-discussion";
    discussion.textContent = "HN discussion";
    discussion.addEventListener("click", event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      dialog.addEventListener("close", () => { location.hash = discussion.hash; }, { once: true });
      manualClose();
    });
    header.insertBefore(discussion, external);
    if (alertStory.hnOnly) {
      bar.hidden = true;
      const article = document.createElement("article");
      article.className = "preview-reader";
      const heading = document.createElement("h1");
      heading.textContent = title;
      article.append(heading);
      content.append(article);
      if (alertStory.text) {
        void import("./sanitize.js?v=41").then(({ sanitizeHNHTML }) => {
          if (signal.aborted) return;
          const text = document.createElement("div");
          text.innerHTML = sanitizeHNHTML(alertStory.text);
          article.append(text);
        }).catch(() => {});
      }
      return;
    }
  }
  void load();
}
