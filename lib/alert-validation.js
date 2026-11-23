const { createHash, ECDH } = require("node:crypto");
const RULE_ID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

class AlertError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireInput(condition, message) {
  if (!condition) throw new AlertError(400, message);
}

function onlyFields(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every(key => fields.includes(key));
}

function base64Key(value, length) {
  if (typeof value !== "string" || value.length > Math.ceil(length / 3) * 4 ||
      !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  const canonical = bytes.toString("base64url");
  return bytes.length === length && value.replace(/=+$/, "") === canonical ? canonical : null;
}

function publicKey(value) {
  const canonical = base64Key(value, 65);
  if (!canonical) return null;
  const bytes = Buffer.from(canonical, "base64url");
  if (bytes[0] !== 4) return null;
  try {
    ECDH.convertKey(bytes, "prime256v1");
    return canonical;
  } catch {
    return null;
  }
}

function alertEndpoint(value) {
  if (typeof value !== "string" || value.length > 2048 ||
      !/^https:\/\//i.test(value) || /[\s\\#\p{Cc}]/u.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname;
  const allowed = host === "web.push.apple.com" || host.endsWith(".push.apple.com") ||
    host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com" ||
    host.endsWith(".notify.windows.com");
  if (!allowed || url.username || url.password || url.port || url.pathname === "/" || url.href.length > 2048) return null;
  return url.href;
}

function subscriptionFrom(value) {
  requireInput(onlyFields(value, ["endpoint", "keys", "expirationTime"]), "Invalid push subscription.");
  const endpoint = alertEndpoint(value.endpoint);
  requireInput(endpoint, "Unsupported push service endpoint.");
  requireInput(value.expirationTime == null ||
    (Number.isSafeInteger(value.expirationTime) && value.expirationTime >= 0), "Invalid subscription expiry.");
  requireInput(onlyFields(value.keys, ["p256dh", "auth"]), "Invalid push subscription keys.");
  const p256dh = publicKey(value.keys.p256dh);
  const auth = base64Key(value.keys.auth, 16);
  requireInput(p256dh && auth, "Invalid push subscription keys.");
  return { id: createHash("sha256").update(endpoint).digest("hex"), endpoint, keys: { p256dh, auth } };
}

function identityFrom(value) {
  requireInput(onlyFields(value, ["id", "auth"]), "Invalid subscription identifier.");
  const auth = base64Key(value.auth, 16);
  requireInput(typeof value.id === "string" && /^[\da-f]{64}$/.test(value.id) && auth,
    "Invalid subscription identifier.");
  return { id: value.id, auth };
}

async function rulesFrom(value) {
  const { MAX_RULES, MAX_TERMS, normalizeKeyword, normalizeAlertDomain } =
    await import("../public/modules/alert-rules.js");
  requireInput(Array.isArray(value) && value.length <= MAX_RULES, "Use up to 10 rules.");
  const ids = new Set();
  return value.map(rule => {
    requireInput(onlyFields(rule, ["id", "keywords", "domain", "minPoints", "frontPage", "enabled"]) &&
      typeof rule.id === "string" && RULE_ID.test(rule.id) && !ids.has(rule.id), "Invalid alert rule.");
    ids.add(rule.id);
    requireInput(Array.isArray(rule.keywords) && rule.keywords.length >= 1 &&
      rule.keywords.length <= MAX_TERMS, "Use 1 to 5 keywords per rule.");
    const keywords = rule.keywords.map(normalizeKeyword);
    requireInput(keywords.every(Boolean), "Use keywords of up to 50 characters. Quote exact phrases.");
    const domain = normalizeAlertDomain(rule.domain);
    requireInput(domain !== null, "Enter a domain such as github.com.");
    requireInput(Number.isInteger(rule.minPoints) && rule.minPoints >= 10 && rule.minPoints <= 1000,
      "Minimum points must be between 10 and 1000.");
    requireInput(typeof rule.frontPage === "boolean" && typeof rule.enabled === "boolean", "Invalid rule options.");
    return { id: rule.id, keywords, domain, minPoints: rule.minPoints,
      frontPage: rule.frontPage, enabled: rule.enabled };
  });
}

module.exports = { AlertError, requireInput, onlyFields, base64Key, publicKey, alertEndpoint,
  subscriptionFrom, identityFrom, rulesFrom, RULE_ID };
