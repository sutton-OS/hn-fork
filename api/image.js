const { articleRoute } = require("../lib/article-route");
const { fetchPublic } = require("../lib/public-fetch");

module.exports = articleRoute(async (url, res) => {
  const { bytes, type } = await fetchPublic(url, {
    accept: "image/*",
    acceptsType: (mime) => /^image\/[a-z0-9][a-z0-9.+-]*$/.test(mime),
    maxBytes: 2 * 1024 * 1024,
  });

  res.setHeader("Content-Type", type);
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  res.setHeader("Content-Disposition", "attachment");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = 200;
  res.end(bytes);
}, 160);
