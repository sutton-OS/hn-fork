export const MAX_RULES = 10;
export const MAX_TERMS = 5;
export const MAX_KEYWORD = 50;

export function normalizeKeyword(value) {
  if (typeof value !== "string" || value.length > MAX_KEYWORD * 2 + 2) return null;
  const quoted = value.startsWith('"') && value.endsWith('"');
  const text = quoted ? value.slice(1, -1) : value;
  if (!text.trim() || text !== text.trim() || Array.from(text).length > MAX_KEYWORD ||
      /["\p{Cc}]/u.test(text) || (!quoted && /[\s,]/u.test(text))) return null;
  return quoted ? '"' + text + '"' : text;
}

export function parseKeywords(value) {
  const terms = [];
  const token = /"[^"]*"|[^",\s]+/uy;
  const separator = /[\s,]+/uy;
  let index = 0;
  while (index < value.length) {
    separator.lastIndex = index;
    if (separator.test(value)) index = separator.lastIndex;
    if (index === value.length) break;
    token.lastIndex = index;
    const match = token.exec(value);
    const keyword = normalizeKeyword(match?.[0]);
    if (!keyword || terms.length >= MAX_TERMS ||
        (token.lastIndex < value.length && !/[\s,]/u.test(value[token.lastIndex]))) return null;
    terms.push(keyword);
    index = token.lastIndex;
  }
  return terms.length ? terms : null;
}

export function normalizeAlertDomain(value) {
  if (typeof value !== "string" || value.length > 253) return null;
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (!domain) return "";
  if (!/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(domain)) {
    return null;
  }
  return domain;
}
