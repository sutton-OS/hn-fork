import DOMPurify from "../vendor/dompurify-3.4.17.es.mjs";
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
