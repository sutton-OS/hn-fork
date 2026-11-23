// Shared by the page and the classic service worker.
(() => {
  let database;
  const pending = new Map();

  function exclusive(name, task) {
    if (navigator.locks?.request) return navigator.locks.request("hnx-alert-" + name, task);
    const next = (pending.get(name) || Promise.resolve()).catch(() => {}).then(task);
    pending.set(name, next);
    return next;
  }

  function openDB() {
    if (!globalThis.indexedDB) return Promise.reject(new Error("Alert storage is unavailable."));
    database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("hnx-alerts", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("settings");
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          database = null;
        };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    }).catch(error => {
      database = null;
      throw error;
    });
    return database;
  }

  async function saved(key, update) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("settings", update ? "readwrite" : "readonly");
      const store = tx.objectStore("settings");
      const request = store.get(key);
      let value;
      request.onsuccess = () => {
        value = update ? update(request.result) : request.result;
        if (update) {
          if (value === undefined) store.delete(key);
          else store.put(value, key);
        }
      };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error || new Error("Alert storage is unavailable."));
    });
  }

  function badge(increment) {
    return exclusive("badge", async () => {
      let count = 0;
      try { count = await saved("unseen", value => increment ? (value || 0) + 1 : 0); } catch {}
      if (increment && navigator.setAppBadge) await navigator.setAppBadge(count || 1);
      if (!increment && navigator.clearAppBadge) await navigator.clearAppBadge();
    });
  }

  async function api(name, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch("/api/" + name, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "omit",
        referrerPolicy: "origin",
        redirect: "error",
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error || "Alert request failed."), {
        status: response.status, result,
      });
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  let keyRequest;
  function getApplicationKey() {
    keyRequest ??= api("subscribe").then(({ publicKey }) => {
      const base64 = publicKey.replace(/-/g, "+").replace(/_/g, "/");
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      if (bytes.length !== 65) throw new Error("Push alerts are unavailable on this deployment.");
      return bytes;
    }).catch(error => {
      keyRequest = null;
      throw error;
    });
    return keyRequest;
  }

  async function createSubscription(manager, mayPrompt) {
    const applicationServerKey = await getApplicationKey();
    const options = { userVisibleOnly: true, applicationServerKey };
    if (!mayPrompt && (!manager.permissionState || await manager.permissionState(options) !== "granted")) {
      return null;
    }
    return manager.subscribe(options);
  }

  function identity(state) {
    return { id: state.id, auth: state.auth };
  }

  async function register(subscription, previous, create) {
    const data = subscription.toJSON();
    const sameEndpoint = previous?.endpoint === new URL(data.endpoint).href;
    const body = { subscription: data };
    if (previous && (!sameEndpoint || previous.auth !== data.keys.auth)) body.previous = identity(previous);
    if (create) body.rules = previous?.rules ?? [];
    const result = await api("subscribe", body);
    const state = { ...result, endpoint: new URL(data.endpoint).href, auth: data.keys.auth };
    await saved("subscription", () => state);
    return state;
  }

  async function synchronize(registration, { interactive = false, replacement } = {}) {
    const previous = await saved("subscription");
    if (!previous && !interactive) return null;
    const manager = registration.pushManager;
    let subscription = replacement || await manager.getSubscription();
    if (!subscription) {
      subscription = await createSubscription(manager, interactive);
      if (!subscription) return null;
    }
    const isNew = !previous || previous.endpoint !== new URL(subscription.endpoint).href;
    try {
      return await register(subscription, previous, isNew);
    } catch (error) {
      if (error.status !== 404 || isNew) throw error;
      if (!interactive) return null;
      // A provider-pruned endpoint is still present in some browsers.
      await subscription.unsubscribe();
      subscription = await createSubscription(manager, true);
      return register(subscription, previous, true);
    }
  }

  async function changeRules(state, rules) {
    try {
      const result = await api("rules", { ...identity(state), revision: state.revision, rules });
      const current = { ...state, ...result };
      await saved("subscription", () => current);
      return current;
    } catch (error) {
      if (error.status === 409) {
        await saved("subscription", () => ({ ...state, rules: error.result.rules, revision: error.result.revision }));
      }
      throw error;
    }
  }

  async function remove(registration) {
    const state = await saved("subscription");
    let subscription;
    let browserRead = true;
    try { subscription = await registration?.pushManager.getSubscription(); } catch { browserRead = false; }
    const data = subscription?.toJSON();
    let liveIdentity;
    if (data && (new URL(data.endpoint).href !== state?.endpoint || data.keys.auth !== state.auth)) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(new URL(data.endpoint).href));
      const id = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      liveIdentity = { id, auth: data.keys.auth };
    }
    if (state) {
      try { await api("unsubscribe", identity(state)); } catch (error) {
        if (error.status !== 404 || liveIdentity?.id !== state.id) throw error;
      }
    }
    if (liveIdentity) await api("unsubscribe", liveIdentity);
    await saved("subscription", () => undefined);
    try {
      if (subscription) await subscription.unsubscribe();
      return browserRead;
    } catch {
      return false;
    }
  }

  globalThis.hnxAlertDevice = { exclusive, saved, badge, api, getApplicationKey, identity,
    synchronize, changeRules, remove };
})();
