// Theme toggle for the static privacy page (shares sessionStorage with the app).
(function () {
  var KEY = "hnx-theme";

  function currentTheme() {
    return document.documentElement.dataset.theme === "light" ? "light" : "dark";
  }

  function updateToggles() {
    var isDark = currentTheme() === "dark";
    document.querySelectorAll("[data-theme-toggle]").forEach(function (button) {
      button.setAttribute("aria-checked", isDark ? "true" : "false");
      button.setAttribute(
        "aria-label",
        isDark ? "Use light mode" : "Use dark mode",
      );
    });
  }

  function applyTheme(theme) {
    var next = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", next === "dark" ? "#111111" : "#f3efe8");
    }
    try {
      sessionStorage.setItem(KEY, next);
    } catch (e) {
      /* ignore quota / private mode */
    }
    updateToggles();
  }

  document.querySelectorAll("[data-theme-toggle]").forEach(function (button) {
    button.addEventListener("click", function () {
      applyTheme(currentTheme() === "dark" ? "light" : "dark");
    });
  });

  updateToggles();
})();
