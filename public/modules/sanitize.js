import DOMPurify from "../vendor/dompurify-3.5.0.es.mjs";
import { getSafeUrl } from "./utils.js";

const SANITIZE_ALLOWED_TAGS = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "em",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "ul",
];

export function sanitizeHNHTML(value) {
  const clean = DOMPurify.sanitize(value ?? "", {
    ALLOWED_TAGS: SANITIZE_ALLOWED_TAGS,
    ALLOWED_ATTR: ["href"],
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    // http(s) only — blocks javascript:, data:, vbscript:, etc.
    ALLOWED_URI_REGEXP: /^(?:https?:)/i,
    RETURN_DOM_FRAGMENT: true,
  });

  clean.querySelectorAll("a").forEach((anchor) => {
    const safeHref = getSafeUrl(anchor.getAttribute("href"));
    if (safeHref) {
      anchor.setAttribute("href", safeHref);
      anchor.setAttribute("rel", "noopener noreferrer");
      anchor.setAttribute("target", "_blank");
    } else {
      anchor.removeAttribute("href");
      anchor.removeAttribute("target");
      anchor.removeAttribute("rel");
    }
  });

  const serializer = document.createElement("div");
  serializer.appendChild(clean);
  return serializer.innerHTML;
}

const ARTICLE_TAGS = [
  ...SANITIZE_ALLOWED_TAGS, "abbr", "article", "caption", "cite", "dd", "del",
  "details", "div", "dl", "dt", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "img", "kbd", "main", "mark", "q", "s", "samp", "section", "small", "sub", "summary",
  "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "var",
];

export function sanitizeArticleHTML(html, { stored = false } = {}) {
  return DOMPurify.sanitize(html ?? "", {
    ALLOWED_TAGS: ARTICLE_TAGS,
    ALLOWED_ATTR: [
      "href", "alt", "title", "colspan", "rowspan", "scope", stored ? "data-saved-image" : "src",
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ADD_URI_SAFE_ATTR: ["data-saved-image"],
    ALLOWED_URI_REGEXP: /^(?:https?:)/i,
    RETURN_DOM_FRAGMENT: true,
  });
}
