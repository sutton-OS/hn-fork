const { articleRoute } = require("../lib/article-route");
const { fetchPublic, FetchError } = require("../lib/public-fetch");
const { extractArticle } = require("../lib/article");

const ONE_HOUR = 3600;
const CACHE_BUDGET = 16 * 1024 * 1024;
const articles = new Map();
let cachedBytes = 0;

function pruneCache(now) {
  for (const [url, article] of articles) {
    if (article.expires > now && cachedBytes <= CACHE_BUDGET && articles.size <= 128) break;
    cachedBytes -= article.bytes;
    articles.delete(url);
  }
}

module.exports = articleRoute(async (url, res) => {
  pruneCache(Date.now());
  let article = articles.get(url);
  if (!article) {
    const response = await fetchPublic(url, {
      accept: "text/html, application/xhtml+xml",
      acceptsType: (type) => type === "text/html" || type === "application/xhtml+xml",
      maxBytes: 3 * 1024 * 1024,
    });
    const extracted = await extractArticle(response);
    if (!extracted) throw new FetchError(422, "There was too little article text to save.");
    const json = JSON.stringify(extracted);
    article = { json, expires: Date.now() + ONE_HOUR * 1000, bytes: Buffer.byteLength(json) };
    cachedBytes -= articles.get(url)?.bytes || 0;
    articles.delete(url);
    articles.set(url, article);
    cachedBytes += article.bytes;
    pruneCache(Date.now());
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", `private, max-age=${Math.max(0, Math.floor((article.expires - Date.now()) / 1000))}`);
  res.statusCode = 200;
  res.end(article.json);
}, 20);
