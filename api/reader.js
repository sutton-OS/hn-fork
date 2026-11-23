const { Worker } = require("node:worker_threads");
const { endpoint, cache } = require("../lib/preview-api");
const { mapWithConcurrency } = require("../lib/hn");
const { fetchPublic, untilAbort, PreviewError, MAX_BYTES } = require("../lib/preview-fetch");

const articles = cache(32);
let active = 0;

async function extractArticle(url, signal) {
  const cached = articles.get(url.href);
  if (cached) return cached;
  if (active >= 4) throw new PreviewError(429, "Reader is busy.");
  active++;
  try {
    const page = await fetchPublic(url.href, { signal });
    if (!page.body) throw new PreviewError(422, "Publisher did not return an HTML article.");
    signal.throwIfAborted();
    const worker = new Worker(require.resolve("../lib/reader-worker"), {
      // jsdom loads ESM parser dependencies from CommonJS on Node 22/24.
      execArgv: ["--experimental-require-module"],
      workerData: { body: page.body, url: page.url.href, contentType: page.headers["content-type"] },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    try {
      const result = await untilAbort(new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.once("exit", () => resolve(null));
      }), signal);
      if (!result) throw new PreviewError(422, "No readable article found.");
      const bytes = Buffer.byteLength(JSON.stringify(result));
      if (bytes > MAX_BYTES) throw new PreviewError(413, "Article is too large.");
      if (bytes <= 512 * 1024) articles.put(url.href, result, 3600000);
      return result;
    } finally {
      await worker.terminate();
    }
  } finally {
    active--;
  }
}

const imageType = headers => (headers["content-type"] || "").split(";")[0].trim().toLowerCase();
const isImage = headers => /^image\/(?:avif|bmp|gif|jpeg|png|webp|x-icon|vnd\.microsoft\.icon)$/.test(imageType(headers));

async function readArticle(url, _origin, signal, offline) {
  const { imageUrls, ...article } = await extractArticle(url, signal);
  if (!offline) {
    if (article.textLength < 200) throw new PreviewError(422, "No readable article of at least 200 characters.");
    return article;
  }

  // Include only images found in the verified article and keep the entire JSON response bounded.
  let remaining = MAX_BYTES - Buffer.byteLength(JSON.stringify(article)) - 32;
  const images = [];
  await mapWithConcurrency(imageUrls, 2, async (src, index) => {
    if (!src || remaining <= 0 || signal.aborted) return;
    try {
      const { body, headers } = await fetchPublic(src, {
        signal, accept: "image/*", accepts: isImage, maxBytes: 2 * 1024 * 1024,
      });
      if (!body?.length) return;
      const image = { index, mime: imageType(headers), base64: body.toString("base64") };
      const bytes = Buffer.byteLength(JSON.stringify(image)) + 1;
      if (bytes <= remaining) {
        images.push(image);
        remaining -= bytes;
      }
    } catch { /* Save the article when a publisher image is unavailable. */ }
  });
  return { ...article, images };
}

module.exports = endpoint(readArticle);
