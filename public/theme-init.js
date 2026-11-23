// Apply the theme before paint and share the session preference across pages.
(() => {
  const key = "hnx-theme";
  const root = document.documentElement;
  const systemTheme = window.matchMedia("(prefers-color-scheme: light)");
  const getSystemTheme = () => systemTheme.matches ? "light" : "dark";
  let preference;

  try {
    const stored = sessionStorage.getItem(key);
    if (stored === "light" || stored === "dark") preference = stored;
  } catch {
    // The system preference still works when storage is unavailable.
  }

  root.dataset.theme = preference ?? getSystemTheme();

  function updateControls() {
    const isLight = root.dataset.theme === "light";
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.setAttribute("aria-pressed", String(isLight));
    });
    const color = getComputedStyle(root).getPropertyValue("--bg").trim();
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
  }

  document.addEventListener("DOMContentLoaded", updateControls, { once: true });
  systemTheme.addEventListener?.("change", () => {
    if (preference) return;
    root.dataset.theme = getSystemTheme();
    updateControls();
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest?.("[data-theme-toggle]")) return;
    preference = root.dataset.theme === "light" ? "dark" : "light";
    root.dataset.theme = preference;
    try {
      sessionStorage.setItem(key, preference);
    } catch {
      // The current page still retains the choice.
    }
    updateControls();
  });
})();
