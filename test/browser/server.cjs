// Deterministic local server: exercise the real API handlers and deployment headers.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const config = require("../../vercel.json");
const now = Math.floor(Date.now() / 1000);
const items = new Map([
  [1, { id: 1, type: "story", title: "Test discussion", by: "author", time: now, kids: [2, 500], text: '<p>Safe story text</p><img src="/unwanted"><script>window.pwned=1</script>' }],
  [2, { id: 2, type: "comment", by: "reader", time: now, text: "<p>Many replies</p>", kids: Array.from({ length: 95 }, (_, i) => 1000 + i) }],
]);
for (let i = 1000; i < 1095; i++) items.set(i, { id: i, type: "comment", by: "reader", time: now, text: `<p>Reply ${i}</p>` });
for (let i = 500; i <= 512; i++) items.set(i, { id: i, type: "comment", by: "reader", time: now, text: `<p>Depth ${i - 500}: a readable comment</p>`, kids: i < 512 ? [i + 1] : [] });
global.fetch = async url => ({
  ok: true,
  json: async () => url.endsWith("stories.json") ? [1] : items.get(Number(url.match(/\/item\/(\d+)\.json$/)?.[1])) || null,
});
const handlers = {
  "/api/stories": require("../../api/stories"),
  "/api/thread": require("../../api/thread"),
  "/api/item": require("../../api/item"),
  "/api/html/feed": require("../../api/html/feed"),
  "/api/html/item": require("../../api/html/item"),
};
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".woff2": "font/woff2" };
http.createServer(async (req, res) => {
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
      await handlers[route](req, res);
      return;
    }
    const relative = route === "/" ? "index.html" : decodeURIComponent(route.slice(1));
    const file = path.resolve(root, "public", relative);
    if (!file.startsWith(path.join(root, "public") + path.sep)) { res.writeHead(403).end(); return; }
    res.setHeader("content-type", `${types[path.extname(file)] || "application/octet-stream"}; charset=utf-8`);
    res.end(fs.readFileSync(file));
  } catch (error) {
    res.statusCode = error.code === "ENOENT" ? 404 : 500;
    res.end("Request failed");
  }
}).listen(4173, "127.0.0.1", () => console.log("HNx test server on http://127.0.0.1:4173"));
