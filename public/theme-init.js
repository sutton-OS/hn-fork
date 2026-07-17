// Apply session theme before paint (sessionStorage only — no cookies / long-term storage).
(function () {
  var KEY = "hnx-theme";
  try {
    var stored = sessionStorage.getItem(KEY);
    var theme = stored === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", theme === "dark" ? "#111111" : "#f3efe8");
    }
  } catch (e) {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  }
})();
