import "./alert-device.js";
import { MAX_RULES, normalizeAlertDomain, parseKeywords } from "./alert-rules.js";
import { isIOS, isStandalone } from "./pwa.js";
import { lockSheetScroll, wireSheetDrag } from "./sheet.js";

const device = globalThis.hnxAlertDevice;
const mobile = matchMedia("(max-width: 768px) and (pointer: coarse)");
const installRequired = () => isIOS && !isStandalone();
const supported = () => Boolean(navigator.serviceWorker && window.PushManager &&
  window.Notification && window.indexedDB);
const permission = () => window.Notification?.permission ?? "unavailable";
const editConflict = "Alert rules changed in another tab. Reopen the editor to review the latest rules.";

async function registrationReady() {
  let timer;
  try {
    return await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Notifications are still loading. Try again.")), 8000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function clearBadge() {
  if (navigator.clearAppBadge) {
    void device.badge(false).catch(() => {});
    return;
  }
  const worker = navigator.serviceWorker?.controller;
  if (worker) worker.postMessage({ type: "clear-alert-badge" });
  else void device.badge(false).catch(() => {});
}

export function wireAlerts(app) {
  const dialog = document.createElement("dialog");
  dialog.className = "preview-dialog alerts-dialog";
  dialog.setAttribute("aria-labelledby", "alerts-title");
  dialog.innerHTML = `
    <section class="preview-panel">
      <header class="preview-header">
        <h2 id="alerts-title">Alerts</h2>
        <button type="button" aria-label="Close alerts" data-close-alerts autofocus>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
        </button>
      </header>
      <div class="preview-content alerts-content">
        <p class="alerts-status" data-alert-status aria-live="polite"></p>
        <p data-alert-install hidden>Install this site to your home screen first (Share, then Add to Home Screen), then turn on alerts.</p>
        <p data-alert-blocked hidden>Allow notifications for HNx in your browser or device settings.</p>
        <p data-alert-unsupported hidden>This browser does not support push notifications.</p>
        <p role="status" class="alerts-message" data-alert-message></p>
        <button type="button" class="btn" data-alert-enable>Enable notifications</button>
        <ul class="alert-rules" aria-label="Alert rules"></ul>
        <form class="alert-editor" hidden>
          <label>Keywords
            <input type="text" name="keywords" required maxlength="520" aria-describedby="alert-keyword-help"
              placeholder='swift, privacy, "open source"'>
          </label>
          <small id="alert-keyword-help">Use 1–5 terms, up to 50 characters each. Quote exact phrases.</small>
          <div class="alert-fields">
            <label>Domain <small>(optional)</small>
              <input type="text" name="domain" inputmode="url" autocapitalize="none" spellcheck="false"
                maxlength="253" placeholder="github.com">
            </label>
            <div>
              <label for="alert-points">Minimum points</label>
              <div class="alert-points">
                <button type="button" class="btn" aria-label="Decrease minimum points" data-alert-step="-10">−</button>
                <input id="alert-points" type="number" name="points" min="10" max="1000" step="1" value="100" required>
                <button type="button" class="btn" aria-label="Increase minimum points" data-alert-step="10">+</button>
              </div>
            </div>
          </div>
          <label class="alert-check"><input type="checkbox" name="frontPage"> Only if on the front page (top 30)</label>
          <div class="alert-actions">
            <button type="submit" class="btn">Save rule</button>
            <button type="button" class="btn" data-alert-cancel>Cancel</button>
          </div>
        </form>
        <div class="alert-actions">
          <button type="button" class="btn" data-alert-add hidden>Add rule</button>
          <button type="button" class="btn" data-alert-test hidden>Send test notification</button>
          <button type="button" class="btn" data-alert-delete hidden>Delete all my alerts</button>
        </div>
        <div data-alert-confirm hidden>
          <p>Delete all alert rules and stop notifications on this device?</p>
          <div class="alert-actions">
            <button type="button" class="btn" data-alert-delete-yes>Delete all</button>
            <button type="button" class="btn" data-alert-delete-cancel>Cancel</button>
          </div>
        </div>
      </div>
    </section>`;
  const find = selector => dialog.querySelector(selector);
  const list = find(".alert-rules");
  const form = find("form");
  const fields = form.elements;
  const enable = find("[data-alert-enable]");
  const add = find("[data-alert-add]");
  const sendTest = find("[data-alert-test]");
  const deleteAll = find("[data-alert-delete]");
  const confirm = find("[data-alert-confirm]");
  const confirmDelete = find("[data-alert-delete-yes]");
  const message = find("[data-alert-message]");
  let state;
  let active = false;
  let busy = false;
  let draft;
  let renderedRevision;
  let renderedEditable;
  let unlockScroll;
  let opener;
  let lastSync = 0;
  let lastPermission;
  let syncQueued = false;

  function showMessage(value = "") {
    message.textContent = value;
  }

  function edit(rule) {
    draft = { id: rule?.id, revision: state.revision };
    showMessage();
    form.reset();
    fields.keywords.setCustomValidity("");
    fields.domain.setCustomValidity("");
    if (rule) {
      fields.keywords.value = rule.keywords.join(", ");
      fields.domain.value = rule.domain;
      fields.points.value = rule.minPoints;
      fields.frontPage.checked = rule.frontPage;
    }
    form.hidden = false;
    fields.keywords.focus();
    render();
  }

  function finishEdit() {
    form.hidden = true;
    draft = undefined;
    render();
  }

  function listRules(editable) {
    if (renderedRevision === state?.revision && renderedEditable === editable) return;
    renderedRevision = state?.revision;
    renderedEditable = editable;
    list.replaceChildren();
    for (const rule of state?.rules ?? []) {
      const row = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = rule.keywords.join(", ");
      const details = document.createElement("small");
      details.textContent = [rule.minPoints + "+ points", rule.domain, rule.frontPage ? "Top 30" : ""]
        .filter(Boolean).join(" · ");
      const description = document.createElement("div");
      description.append(title, details);
      row.append(description);

      const actions = document.createElement("div");
      actions.className = "alert-actions";
      for (const [label, callback] of [
        [rule.enabled ? "Disable" : "Enable", () => updateRules(state.rules.map(item =>
          item.id === rule.id ? { ...item, enabled: !item.enabled } : item))],
        ["Edit", () => edit(rule)],
        ["Delete", () => updateRules(state.rules.filter(item => item.id !== rule.id))],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn";
        button.textContent = label;
        button.setAttribute("aria-label", label + " rule " + title.textContent);
        button.disabled = !editable;
        button.addEventListener("click", callback);
        actions.append(button);
      }
      row.append(actions);
      list.append(row);
    }
  }

  function render() {
    const install = installRequired();
    const available = supported() && !install;
    const current = permission();
    const registered = active && current === "granted";
    find("[data-alert-status]").textContent = "Permission: " + ({
      granted: "Granted", denied: "Denied", default: "Not requested", unavailable: "Unavailable",
    }[current] || current) + " · Subscribed: " + (registered ? "Yes" : "No");
    find("[data-alert-install]").hidden = !install;
    find("[data-alert-blocked]").hidden = !available || current !== "denied";
    find("[data-alert-unsupported]").hidden = install || available;
    enable.hidden = !available || registered || current === "denied";
    enable.disabled = busy;
    add.hidden = !registered || !form.hidden || state?.rules.length >= MAX_RULES;
    sendTest.hidden = !registered;
    deleteAll.hidden = !state || !confirm.hidden;
    for (const button of [add, sendTest, deleteAll, confirmDelete]) button.disabled = busy;
    form.querySelector('button[type="submit"]').disabled = busy || !registered;
    listRules(registered && !busy);
  }

  async function perform(task) {
    if (busy) return;
    busy = true;
    showMessage();
    render();
    try {
      await device.exclusive("subscription", task);
    } catch (error) {
      if (error.status === 409 && state) {
        state = { ...state, rules: error.result.rules, revision: error.result.revision };
        showMessage(draft ? editConflict : error.message);
        return;
      }
      if (error.status === 404 || error.status === 410) active = false;
      showMessage(error.name === "AbortError" || error.name === "TypeError"
        ? "Could not reach HNx alerts. Try again." : error.message || "Alert request failed.");
    } finally {
      busy = false;
      render();
      if (syncQueued) {
        syncQueued = false;
        refresh({ force: true });
      }
    }
  }

  function updateRules(rules, after) {
    void perform(async () => {
      state = await device.changeRules(state, rules);
      after?.();
      showMessage("Alert rules saved.");
    });
  }

  function refresh({ force = false } = {}) {
    if (installRequired() || !supported()) return;
    const currentPermission = permission();
    if (!force && currentPermission === lastPermission && Date.now() - lastSync < 1500) return;
    if (busy) {
      syncQueued = true;
      return;
    }
    lastSync = Date.now();
    lastPermission = currentPermission;
    void perform(async () => {
      state = await device.saved("subscription");
      if (!state || permission() !== "granted") {
        active = false;
        return;
      }
      const current = await device.synchronize(await registrationReady());
      active = Boolean(current);
      state = current ?? state;
    });
  }

  function close() {
    if (!dialog.open) return;
    dialog.close();
    dialog.remove();
    dialog.classList.remove("is-visible");
    finishEdit();
    confirm.hidden = true;
    unlockScroll?.();
    opener?.focus({ preventScroll: true });
  }

  app.addEventListener("click", event => {
    const button = event.target.closest("[data-alerts]");
    if (!button || dialog.open) return;
    opener = button;
    render();
    unlockScroll = lockSheetScroll();
    document.body.append(dialog);
    dialog.showModal();
    requestAnimationFrame(() => dialog.classList.add("is-visible"));
    if (supported() && !installRequired() && permission() !== "denied") {
      void device.getApplicationKey().catch(() => {});
    }
    refresh({ force: true });
  });
  find("[data-close-alerts]").addEventListener("click", close);
  dialog.addEventListener("hnx-close-sheet", close);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("click", event => { if (event.target === dialog) close(); });
  dialog.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    event.stopPropagation();
  });
  if (mobile.matches) wireSheetDrag(find(".preview-header"), find(".preview-panel"), close);

  enable.addEventListener("click", () => {
    if (busy || installRequired() || !supported() || permission() === "denied") return;
    // Keep the permission request on the tap's synchronous call stack.
    const grant = permission() === "granted" ? Promise.resolve("granted") : Notification.requestPermission();
    void perform(async () => {
      if (await grant !== "granted") return;
      state = await device.synchronize(await registrationReady(), { interactive: true });
      active = Boolean(state);
      if (active) showMessage("Notifications enabled.");
    });
  });
  add.addEventListener("click", () => edit());
  find("[data-alert-cancel]").addEventListener("click", () => { finishEdit(); add.focus(); });
  for (const input of [fields.keywords, fields.domain]) {
    input.addEventListener("input", () => input.setCustomValidity(""));
  }
  for (const step of dialog.querySelectorAll("[data-alert-step]")) {
    step.addEventListener("click", () => {
      const points = Number.isFinite(fields.points.valueAsNumber) ? fields.points.valueAsNumber : 100;
      fields.points.value = Math.min(1000, Math.max(10, points + Number(step.dataset.alertStep)));
    });
  }
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!active || !draft) return;
    if (draft.revision !== state.revision) {
      showMessage(editConflict);
      return;
    }
    const keywords = parseKeywords(fields.keywords.value);
    const domain = normalizeAlertDomain(fields.domain.value);
    fields.keywords.setCustomValidity(keywords ? "" : "Use 1–5 terms of up to 50 characters and close any quotes.");
    fields.domain.setCustomValidity(domain === null ? "Enter a domain such as github.com." : "");
    if (!form.reportValidity()) return;
    const existing = state.rules.find(rule => rule.id === draft.id);
    if ((!existing && draft.id) || (!existing && state.rules.length >= MAX_RULES)) {
      finishEdit();
      showMessage("The rules changed. Review them and try again.");
      return;
    }
    const rule = { id: existing?.id ?? crypto.randomUUID(), keywords, domain,
      minPoints: fields.points.valueAsNumber, frontPage: fields.frontPage.checked, enabled: existing?.enabled ?? true };
    const rules = existing ? state.rules.map(item => item.id === existing.id ? rule : item) : [...state.rules, rule];
    updateRules(rules, finishEdit);
  });
  sendTest.addEventListener("click", () => void perform(async () => {
    await device.api("test", device.identity(state));
    showMessage("Test notification sent.");
  }));
  deleteAll.addEventListener("click", () => { confirm.hidden = false; render(); confirmDelete.focus(); });
  find("[data-alert-delete-cancel]").addEventListener("click", () => {
    confirm.hidden = true;
    render();
    deleteAll.focus();
  });
  confirmDelete.addEventListener("click", () => void perform(async () => {
    const registration = await navigator.serviceWorker.getRegistration().catch(() => null);
    const removed = await device.remove(registration);
    state = null;
    active = false;
    confirm.hidden = true;
    finishEdit();
    clearBadge();
    showMessage(removed ? "All alerts deleted." : "All alerts deleted from HNx. Browser cleanup is pending.");
  }));

  function onOpen() {
    if (document.hidden) return;
    clearBadge();
    refresh();
  }
  window.addEventListener("pageshow", onOpen);
  window.addEventListener("focus", onOpen);
  document.addEventListener("visibilitychange", onOpen);
  if (document.readyState === "complete") onOpen();
}
