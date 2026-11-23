const { createHmac } = require("node:crypto");
const { isIP } = require("node:net");
const { sendJSON } = require("./hn");
const { createAlertStore } = require("./alert-store");
const { vapidFrom, sendAlert, deliverAlert, testPayload } = require("./alert-push");
const { AlertError, requireInput, onlyFields, subscriptionFrom, identityFrom, rulesFrom,
  RULE_ID } = require("./alert-validation");

const MAX_BODY = 16 * 1024;

function alertConfig(env = process.env) {
  const vapid = vapidFrom(env);
  const secret = env.CRON_SECRET;
  let origin;
  let redis;
  try {
    origin = new URL(env.ALERTS_ORIGIN);
    redis = new URL(env.UPSTASH_REDIS_REST_URL);
  } catch { return null; }
  if (!vapid || origin.origin !== env.ALERTS_ORIGIN ||
      (origin.protocol !== "https:" && origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1") ||
      redis.protocol !== "https:" || redis.username || redis.password ||
      !env.UPSTASH_REDIS_REST_TOKEN || typeof secret !== "string" || secret.length < 32) return null;
  return { origin: origin.origin, vapid, secret,
    store: createAlertStore({ url: redis.href, token: env.UPSTASH_REDIS_REST_TOKEN }) };
}

async function bodyFrom(req) {
  const length = req.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) {
    throw new AlertError(413, "Alert request is too large.");
  }
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json" ||
      req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") {
    throw new AlertError(415, "Use an application/json request.");
  }
  try {
    let body;
    if (typeof req.iterator === "function" && !req.readableEnded) {
      const chunks = [];
      let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > MAX_BODY) {
          req.resume();
          throw new AlertError(413, "Alert request is too large.");
        }
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    } else body = req.body;
    const raw = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    if (Buffer.byteLength(raw) > MAX_BODY) throw new AlertError(413, "Alert request is too large.");
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof AlertError) throw error;
    throw new AlertError(400, "Invalid JSON request.");
  }
}

function statusFor(subscription) {
  return { id: subscription.id, rules: subscription.rules, revision: subscription.revision };
}

function clientKey(req, secret) {
  const forwarded = req.headers["x-vercel-forwarded-for"];
  const forwardedIP = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "";
  const ip = process.env.VERCEL === "1" && isIP(forwardedIP) ? forwardedIP : req.socket?.remoteAddress;
  return createHmac("sha256", secret).update(ip || "unknown").digest("hex");
}

async function enforceRateLimit(store, res, key, limit, seconds) {
  if (await store.countRequest(key, seconds) > limit) {
    res.setHeader("retry-after", String(seconds));
    throw new AlertError(429, "Too many alert requests. Please try again later.");
  }
}

function createAlertHandler(action, { configFor = alertConfig, push = sendAlert } = {}) {
  return async (req, res) => {
    const config = configFor();
    const methods = action === "subscribe" ? ["GET", "POST"] : ["POST"];
    if (!methods.includes(req.method)) {
      res.setHeader("allow", methods.join(", "));
      return sendJSON(res, 405, { error: "Method not allowed." });
    }
    if (!config) return sendJSON(res, 503, { error: "Push alerts are unavailable on this deployment." });
    const origin = req.headers.origin;
    if ((origin && origin !== config.origin) || (req.method === "POST" && origin !== config.origin)) {
      return sendJSON(res, 403, { error: "Origin not allowed." });
    }
    if (origin) {
      res.setHeader("access-control-allow-origin", config.origin);
      res.setHeader("vary", "Origin");
    }
    if (req.method === "GET") return sendJSON(res, 200, { publicKey: config.vapid.publicKey });

    const { store, secret, vapid } = config;
    try {
      const ip = clientKey(req, secret);
      await enforceRateLimit(store, res, ip, 60, 60);
      const body = await bodyFrom(req);
      if (action === "subscribe") {
        requireInput(onlyFields(body, ["subscription", "rules", "previous"]), "Invalid subscribe request.");
        const subscription = subscriptionFrom(body.subscription);
        const rules = body.rules === undefined ? undefined : await rulesFrom(body.rules);
        const previous = body.previous === undefined ? undefined : identityFrom(body.previous);
        const saved = await store.register(subscription, rules, previous);
        if (!saved) throw new AlertError(404, "Subscription not found.");
        return sendJSON(res, 200, statusFor(saved));
      }

      const fields = action === "rules" ? ["id", "auth", "rules", "revision"] : ["id", "auth"];
      requireInput(onlyFields(body, fields), "Invalid alert request.");
      const identity = identityFrom({ id: body.id, auth: body.auth });
      if (action === "unsubscribe") {
        const removed = await store.remove(identity.id, identity.auth);
        if (removed === -1) throw new AlertError(404, "Subscription not found.");
        return sendJSON(res, 200, { deleted: true });
      }
      if (action === "rules" && body.rules !== undefined) {
        requireInput(typeof body.revision === "string" && RULE_ID.test(body.revision), "Invalid rules revision.");
        const { status, subscription } = await store.setRules(identity, body.revision, await rulesFrom(body.rules));
        if (status === 404) throw new AlertError(404, "Subscription not found.");
        if (status === 409) return sendJSON(res, 409, { ...statusFor(subscription),
          error: "Rules changed in another window. Review them and try again." });
        return sendJSON(res, 200, statusFor(subscription));
      }

      const subscription = await store.get(identity.id);
      if (subscription?.keys.auth !== identity.auth) throw new AlertError(404, "Subscription not found.");
      if (action === "rules") return sendJSON(res, 200, statusFor(subscription));

      await enforceRateLimit(store, res, "test:" + ip, 3, 600);
      const { group } = await store.reserve(subscription, [], { test: true });
      if (!group) res.setHeader("retry-after", "3600");
      if (!group) throw new AlertError(429, "This subscription reached its hourly notification limit.");
      const result = await deliverAlert({ store, subscription, group, payload: testPayload,
        send: (item, payload) => push(item, payload, vapid) });
      if (result === "pruned" || result === "stale") {
        throw new AlertError(410, "This subscription has expired. Enable notifications again.");
      }
      if (result !== "sent") throw new AlertError(502, "The push service could not accept the notification.");
      return sendJSON(res, 200, { sent: true });
    } catch (error) {
      if (error instanceof AlertError) return sendJSON(res, error.status, { error: error.message });
      console.error("HNx alerts API failed", { action });
      return sendJSON(res, 503, { error: "Push alerts are temporarily unavailable." });
    }
  };
}

module.exports = { alertConfig, createAlertHandler };
