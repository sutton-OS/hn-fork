const INSTALL_DISMISSED = "hnx-install-hint-dismissed";
const PULL_THRESHOLD = 70;
const PULL_RETURN_MS = 260;
const standalone = matchMedia("(display-mode: standalone)");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

export const touchInput = matchMedia("(pointer: coarse)");

const { userAgent, platform, maxTouchPoints } = navigator;
const hasTouch = maxTouchPoints > 0 || "ontouchstart" in window;
export const isIOS = /iPad|iPhone|iPod/.test(userAgent) ||
  (platform === "MacIntel" && maxTouchPoints > 1);
const isSafari = /Version\/[\d.]+.*Safari\//.test(userAgent) &&
  !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA|YaBrowser/.test(userAgent);
export const isStandalone = () => navigator.standalone === true || standalone.matches;

function wireInstallHint() {
  if (!isIOS || !isSafari || !hasTouch) return;
  const hint = document.querySelector(".install-hint");
  let dismissed = false;

  function updateHint() {
    try {
      dismissed ||= localStorage.getItem(INSTALL_DISMISSED) === "1";
    } catch {
      // The hint can still be dismissed for this page.
    }
    hint.hidden = dismissed || isStandalone();
  }

  hint.querySelector("button").addEventListener("click", () => {
    dismissed = true;
    try {
      localStorage.setItem(INSTALL_DISMISSED, "1");
    } catch {
      // The in-memory dismissal still applies.
    }
    updateHint();
  });
  standalone.addEventListener("change", updateHint);
  window.addEventListener("pageshow", updateHint);
  updateHint();
}

function wireRowPress(app) {
  let press;
  const release = () => {
    press?.row.classList.remove("is-pressed");
    press = null;
  };
  app.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    const row = event.target.closest(".story-list .story");
    if (!row) return;
    // Touch browsers can defer :active on non-link parts of a row.
    release();
    press = { row, id: event.pointerId, x: event.clientX, y: event.clientY };
    row.classList.add("is-pressed");
  }, { passive: true });
  app.addEventListener("pointermove", (event) => {
    if (press?.id === event.pointerId &&
        Math.max(Math.abs(event.clientX - press.x), Math.abs(event.clientY - press.y)) > 8) release();
  }, { passive: true });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture", "contextmenu"]) {
    app.addEventListener(type, release, { passive: true });
  }
}

function wirePullToRefresh(app, refresh) {
  if (!isIOS || !hasTouch) return;

  let pull = null;
  let pendingRefresh = false;
  const atTop = () => (document.scrollingElement?.scrollTop ?? 0) <= 0;
  const sheetOpen = () => document.body.classList.contains("preview-open");

  function endPull(shouldRefresh = false) {
    if (!pull) return;
    const { panel } = pull;
    pull = null;
    if (!panel.classList.contains("is-pulling")) return;

    panel.classList.add("is-pull-returning");
    panel.classList.remove("is-pulling", "is-pull-ready");
    panel.style.removeProperty("--pull-offset");
    pendingRefresh = shouldRefresh;
    window.setTimeout(() => {
      panel.classList.remove("is-pull-returning");
      pendingRefresh = false;
      if (shouldRefresh && panel.isConnected && isStandalone() && !sheetOpen() && atTop()) refresh();
    }, reducedMotion.matches ? 0 : PULL_RETURN_MS);
  }

  app.addEventListener("touchstart", (event) => {
    if (pull) endPull();
    if (!isStandalone() || sheetOpen() || pendingRefresh || !atTop() || event.touches.length !== 1) return;
    const panel = event.target.closest("#feed-panel");
    if (!panel || panel.matches('[aria-busy="true"], .is-pull-returning') ||
        event.target.closest("input, select, textarea, [contenteditable]")) return;
    const touch = event.touches[0];
    pull = { panel, x: touch.clientX, y: touch.clientY, distance: 0 };
  }, { passive: true });

  app.addEventListener("touchmove", (event) => {
    if (!pull) return;
    if (event.touches.length !== 1 || sheetOpen() || !atTop()) {
      endPull();
      return;
    }
    const touch = event.touches[0];
    const distance = touch.clientY - pull.y;
    const sideways = Math.abs(touch.clientX - pull.x);
    if (distance < -6 || (sideways > 8 && sideways > distance)) {
      endPull();
      return;
    }
    pull.distance = distance;
    if (distance < 6 && !pull.panel.classList.contains("is-pulling")) return;
    pull.panel.style.setProperty("--pull-offset", `${Math.min(64, Math.max(0, distance) * 0.58)}px`);
    pull.panel.classList.add("is-pulling");
    pull.panel.classList.toggle("is-pull-ready", distance >= PULL_THRESHOLD);
  }, { passive: true });

  app.addEventListener("touchend", () => {
    endPull(pull?.distance >= PULL_THRESHOLD && atTop() && !sheetOpen());
  }, { passive: true });
  app.addEventListener("touchcancel", () => endPull(), { passive: true });
}

export function wirePWA(app, refresh) {
  wireInstallHint();
  if (hasTouch) wireRowPress(app);
  wirePullToRefresh(app, refresh);

  if ("serviceWorker" in navigator) {
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch((error) => {
        console.warn("HNx service worker registration failed", error);
      });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }
}
