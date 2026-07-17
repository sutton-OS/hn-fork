// First-paint stories prefetch (same-origin only).
(() => {
  const url = "/api/stories?feed=best&offset=0&limit=12";
  window.__hnxStoriesPrefetch = {
    url,
    promise: fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) {
          return null;
        }
        const data = await response.json();
        return Array.isArray(data) ? data : null;
      })
      .catch(() => null),
  };
})();
