const { Readability } = require("@mozilla/readability");
const createDOMPurify = require("dompurify");

const MIN_TEXT_LENGTH = 100;
const TAGS = [
  "a", "abbr", "article", "b", "blockquote", "br", "caption", "cite", "code", "dd", "del",
  "details", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "i", "img", "kbd", "li", "main", "mark", "ol", "p", "pre", "q", "s", "samp", "section",
  "small", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th",
  "thead", "tr", "u", "ul", "var",
];

async function extractArticle({ bytes, url, contentType }) {
  const { JSDOM } = await import("jsdom");
  // JSDOM's default mode leaves scripts and subresource loading disabled.
  const { window } = new JSDOM(bytes, { url, contentType });
  try {
    const { document } = window;
    document.querySelectorAll("base, script, iframe, form, object, embed, template").forEach((node) => node.remove());
    const article = new Readability(document, { charThreshold: MIN_TEXT_LENGTH, maxElemsToParse: 30_000 }).parse();
    if (!article) return null;

    const body = createDOMPurify(window).sanitize(article.content, {
      ALLOWED_TAGS: TAGS,
      ALLOWED_ATTR: ["href", "src", "alt", "title", "colspan", "rowspan", "scope"],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      ALLOWED_URI_REGEXP: /^(?:https?:)/i,
      RETURN_DOM: true,
    });
    const textLength = body.textContent.replace(/\s+/g, " ").trim().length;
    if (textLength < MIN_TEXT_LENGTH) return null;

    return {
      title: article.title || "",
      byline: article.byline || "",
      siteName: article.siteName || "",
      html: body.innerHTML,
      textLength,
    };
  } finally {
    window.close();
  }
}

module.exports = { extractArticle };
