// Deterministic local server: exercise the real API handlers and deployment headers.
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns/promises");
const { AsyncLocalStorage } = require("node:async_hooks");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const config = require("../../vercel.json");
const fixtures = new AsyncLocalStorage();
const now = Math.floor(Date.now() / 1000);
const items = new Map([
  [1, { id: 1, type: "story", title: "Test discussion", by: "author", time: now, kids: [2, 500], text: '<p>Safe story text</p><img src="/unwanted"><script>window.pwned=1</script>' }],
  [2, { id: 2, type: "comment", by: "reader", time: now, text: "<p>Many replies</p>", kids: Array.from({ length: 95 }, (_, i) => 1000 + i) }],
]);
for (let i = 1000; i < 1095; i++) items.set(i, { id: i, type: "comment", by: "reader", time: now, text: `<p>Reply ${i}</p>` });
for (let i = 500; i <= 512; i++) items.set(i, { id: i, type: "comment", by: "reader", time: now, text: `<p>Depth ${i - 500}: a readable comment</p>`, kids: i < 512 ? [i + 1] : [] });
const offlineItems = [
  { id: 20, type: "story", title: "Field notes", time: now, score: 45, descendants: 8, url: "https://publisher.example/notes" },
  { id: 21, type: "story", title: "A short article", time: now, url: "https://publisher.example/short" },
];
global.fetch = async url => ({
  ok: true,
  json: async () => {
    const offline = fixtures.getStore();
    if (url.endsWith("stories.json")) {
      if (!offline) return [1];
      if (url.endsWith("topstories.json")) return [21, 20];
      if (url.endsWith("newstories.json")) return [20];
      return [20, 21];
    }
    const id = Number(url.match(/\/item\/(\d+)\.json$/)?.[1]);
    return items.get(id) || offlineItems.find((item) => item.id === id) || null;
  },
});

const lookup = dns.lookup;
dns.lookup = (host, ...args) => host === "publisher.example"
  ? Promise.resolve([{ address: "93.184.216.34", family: 4 }]) : lookup(host, ...args);
const request = https.request;
https.request = (url, options, callback) => {
  if (url.hostname !== "publisher.example") return request(url, options, callback);
  const text = "Field research for the offline reader. This paragraph describes a week of clear observations. ".repeat(6);
  const photo = url.pathname === "/photo.png";
  const html = url.pathname === "/short"
    ? "<title>A short article</title><p>Just a few words.</p>"
    : `<title>Field notes</title><article><p>${text}</p><figure><img src="/photo.png" alt="Field photo"></figure>
       <img src="/missing.png" alt="Missing photo"><script>window.fixtureRan = true</script></article>`;
  const body = Readable.from([photo ? fs.readFileSync(path.join(root, "public/favicon-32x32.png")) : Buffer.from(html)]);
  body.statusCode = url.pathname === "/missing.png" ? 404 : 200;
  body.headers = { "content-type": photo ? "image/png" : "text/html; charset=utf-8" };
  return Object.assign(new EventEmitter(), { end: () => queueMicrotask(() => callback(body)) });
};
const handlers = {
  "/api/embeddable": require("../../api/embeddable"),
  "/api/reader": require("../../api/reader"),
  "/api/stories": require("../../api/stories"),
  "/api/thread": require("../../api/thread"),
  "/api/item": require("../../api/item"),
  "/api/html/feed": require("../../api/html/feed"),
  "/api/html/item": require("../../api/html/item"),
};
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".woff2": "font/woff2" };
function createTestServer({ isNewShell = () => false } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    for (const rule of config.headers) {
      if (new RegExp(`^${rule.source}$`).test(url.pathname)) {
        for (const header of rule.headers) res.setHeader(header.key, header.value);
      }
    }
    let route = url.pathname;
    const plain = route.match(/^\/(plain|classic)(?:\/(?:item\/(\d+)|(best|top|new)))?$/);
    if (plain) {
      url.searchParams.set("skin", plain[1]);
      if (plain[2]) { route = "/api/html/item"; url.searchParams.set("id", plain[2]); }
      else { route = "/api/html/feed"; url.searchParams.set("feed", plain[3] || "best"); }
    }
    try {
      if (handlers[route]) {
        req.query = Object.fromEntries(url.searchParams);
        res.status = status => { res.statusCode = status; return res; };
        res.send = body => res.end(body);
        await fixtures.run(req.headers.cookie?.includes("hnx-offline-fixture=1"), () => handlers[route](req, res));
        return;
      }
      const relative = route === "/" ? "index.html" : decodeURIComponent(route.slice(1));
      const file = path.resolve(root, "public", relative);
      if (!file.startsWith(path.join(root, "public") + path.sep)) { res.writeHead(403).end(); return; }
      res.setHeader("content-type", `${types[path.extname(file)] || "application/octet-stream"}; charset=utf-8`);
      let content = fs.readFileSync(file);
      if (isNewShell()) {
        if (relative === "sw.js") content = content.toString().replace('"shell-v5"', '"shell-v6"');
        if (relative === "index.html") content = content.toString().replace("<title>HNx</title>", "<title>HNx updated</title>");
      }
      res.end(content);
    } catch (error) {
      res.statusCode = error.code === "ENOENT" ? 404 : 500;
      res.end("Request failed");
    }
  });
}

module.exports = { createTestServer };
if (require.main === module) {
  createTestServer().listen(4173, "127.0.0.1", () => console.log("HNx test server on http://127.0.0.1:4173"));
}
