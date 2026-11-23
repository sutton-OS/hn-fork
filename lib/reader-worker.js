// Parsing runs off the request thread so the caller can enforce its deadline even
// during synchronous DOM work. jsdom's default disables scripts and subresources.
const { parentPort, workerData } = require("node:worker_threads");
const { JSDOM, VirtualConsole } = require("jsdom");
const { Readability } = require("@mozilla/readability");
const createDOMPurify = require("dompurify");

function extract({ body, url, contentType }) {
  const dom = new JSDOM(Buffer.from(body), {
    url, contentType: contentType.replace(/^application\/xhtml\+xml/i, "text/html"),
    virtualConsole: new VirtualConsole(),
  });
  try {
    const purifier = createDOMPurify(dom.window);
    const { document } = dom.window;
    document.querySelectorAll("base, script, iframe, form, object, embed, template").forEach(el => el.remove());
    const article = new Readability(document, { charThreshold: 100, maxElemsToParse: 30000 }).parse();
    if (!article) return null;
    const clean = purifier.sanitize(article.content, {
      ALLOWED_TAGS: ["p", "br", "section", "div", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre",
        "code", "strong", "b", "em", "i", "sub", "sup", "ul", "ol", "li", "a", "img", "figure",
        "figcaption", "hr", "table", "thead", "tbody", "tr", "th", "td", "dl", "dt", "dd"],
      ALLOWED_ATTR: ["href", "src", "alt", "title"],
      ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM: true,
    });
    for (const el of clean.querySelectorAll("a, img")) {
      const image = el.localName === "img";
      const attr = image ? "src" : "href";
      const raw = el.getAttribute(attr);
      let dest;
      try { if (raw) dest = new URL(raw, url); } catch {}
      if (!dest || !["https:", "http:"].includes(dest.protocol) || dest.username || dest.password) {
        el.removeAttribute(attr);
        continue;
      }
      el.setAttribute(attr, dest.href);
      if (image) {
        el.setAttribute("loading", "lazy");
        el.setAttribute("referrerpolicy", "no-referrer");
      } else {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
    }
    const textLength = clean.textContent.replace(/\s+/g, " ").trim().length;
    if (textLength < 100) return null;
    const imageUrls = Array.from(clean.querySelectorAll("img")).slice(0, 8).map(img => img.getAttribute("src"));
    return { title: article.title || document.title || clean.querySelector("h2, h3")?.textContent || "", byline: article.byline, siteName: article.siteName || new URL(url).hostname,
      html: clean.innerHTML, textLength, imageUrls };
  } finally {
    dom.window.close();
  }
}

try { parentPort.postMessage(extract(workerData)); }
catch { parentPort.postMessage(null); }
