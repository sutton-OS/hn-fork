const { Worker } = require("node:worker_threads");
const { endpoint, cache } = require("../lib/preview-api");
const { fetchPublic, untilAbort, PreviewError, MAX_BYTES } = require("../lib/preview-fetch");

const articles = cache(32);
let active = 0;

async function readArticle(url, _origin, signal) {
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
      if (!result) throw new PreviewError(422, "No readable article of at least 200 characters.");
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
module.exports = endpoint(readArticle);
