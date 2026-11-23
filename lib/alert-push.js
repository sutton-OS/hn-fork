const { createECDH } = require("node:crypto");
const { base64Key, publicKey, subscriptionFrom } = require("./alert-validation");

const HN_ITEM = "https://news.ycombinator.com/item?id=";

function vapidFrom(env) {
  const subject = env.VAPID_SUBJECT;
  const publicVapidKey = publicKey(env.VAPID_PUBLIC_KEY);
  const privateKey = base64Key(env.VAPID_PRIVATE_KEY, 32);
  if (!publicVapidKey || !privateKey || typeof subject !== "string" ||
      subject.length > 254 || !/^mailto:[^\s@?]+@[^\s@?]+\.[^\s@?]+$/i.test(subject)) return null;
  try {
    const key = createECDH("prime256v1");
    key.setPrivateKey(Buffer.from(privateKey, "base64url"));
    if (key.getPublicKey().toString("base64url") !== publicVapidKey) return null;
    return { subject, publicKey: publicVapidKey, privateKey };
  } catch {
    return null;
  }
}

const shorten = (value, max) => Array.from(value).slice(0, max).join("");

function storyPayload(story) {
  return {
    id: story.id,
    title: shorten(story.title, 100),
    points: story.score,
    comments: story.descendants,
    domain: story.domain,
    url: story.url,
    hnUrl: HN_ITEM + story.id,
  };
}

const testPayload = {
  title: "HNx test notification", points: 100, comments: 12, domain: "news.ycombinator.com",
};

function summaryPayload(count) {
  return { title: count === 1 ? "1 more story matches your alerts" : count + " more stories match your alerts",
    body: "Open HNx to browse stories.", tag: "hnx-alert-summary" };
}

async function sendAlert(subscription, payload, vapidDetails) {
  // Revalidate at the outbound boundary as well as when accepting the subscription.
  const { endpoint, keys } = subscriptionFrom({ endpoint: subscription.endpoint, keys: subscription.keys });
  const { sendNotification } = await import("web-push");
  await sendNotification({ endpoint, keys }, JSON.stringify(payload), {
    vapidDetails, TTL: 6 * 60 * 60, urgency: "normal", timeout: 8000,
  });
}

async function deliverAlert({ store, subscription, group, payload, send }) {
  let current;
  try {
    current = await store.get(subscription.id);
  } catch (error) {
    await store.release(subscription.id, group).catch(() => {});
    throw error;
  }
  if (current?.revision !== subscription.revision) {
    await store.release(subscription.id, group);
    return "stale";
  }
  try {
    await send(current, payload);
    return "sent";
  } catch (error) {
    const status = error?.statusCode;
    if (status === 404 || status === 410) {
      const removed = await store.remove(current.id, current.keys.auth, current.keys.p256dh);
      if (removed === 1) return "pruned";
      await store.release(subscription.id, group);
      return "stale";
    }
    if (status >= 400 && status < 500) await store.release(subscription.id, group);
    // Keep the reservation on an ambiguous response or timeout. A push service
    // may have accepted the request before the connection failed.
    return "failed";
  }
}

module.exports = { vapidFrom, storyPayload, testPayload, summaryPayload, sendAlert, deliverAlert };
