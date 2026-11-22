import { FEED_BEST, INITIAL_PAGE_SIZE, STORIES_ENDPOINT } from "./modules/config.js";
import { parseRoute } from "./modules/routing.js";

if (parseRoute().type === "list") {
  const url = `${STORIES_ENDPOINT}?feed=${FEED_BEST}&offset=0&limit=${INITIAL_PAGE_SIZE}`;
  window.__hnxStoriesPrefetch = {
    url,
    promise: fetch(url, {
      headers: { accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) {
          return null;
        }
        const data = await response.json();
        // Support structured { stories } and legacy array payloads.
        if (Array.isArray(data)) {
          return data;
        }
        if (data && typeof data === "object" && Array.isArray(data.stories)) {
          return data;
        }
        return null;
      })
      .catch(() => null),
  };
}
