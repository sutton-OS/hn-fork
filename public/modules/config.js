export const STORIES_ENDPOINT = "/api/stories";
export const ITEM_ENDPOINT = "/api/item";
export const THREAD_ENDPOINT = "/api/thread";
export const PAGE_SIZE = 30;
export const INITIAL_PAGE_SIZE = 12;
/** Direct replies fetched per expand / root page (server-side page size). */
export const COMMENTS_PAGE_SIZE = 40;
/** DOM nodes mounted per animation frame within a page. */
export const COMMENTS_DOM_BATCH = 20;
/** Visual indent cap — deeper threads stay readable. */
export const MAX_COMMENT_DEPTH = 6;
/** px — clamp long comment bodies past this height. */
export const COMMENT_CLAMP_PX = 168;
export const FEED_BEST = "best";
export const FEED_TOP = "top";
export const FEED_NEW = "new";
export const FEEDS = [FEED_BEST, FEED_TOP, FEED_NEW];
export const LIST_VISIBLE_REFRESH_AFTER_MS = 60 * 1000;
export const THREAD_PREFETCH_MAX = 24;
export const THREAD_PREFETCH_TTL_MS = 30_000;
/** Session-only theme key (survives privacy page navigation; clears with the tab). */
export const THEME_STORAGE_KEY = "hnx-theme";
