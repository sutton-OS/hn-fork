import { FEEDS, FEED_TOP, FEED_NEW, THEME_STORAGE_KEY } from "./config.js";
import { normalizeFeed } from "./utils.js";

export function createUI({ app, getCurrentFeed, setFeed }) {
  function readStoredTheme() {
    try {
      const stored = sessionStorage.getItem(THEME_STORAGE_KEY);
      return stored === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  }

  function updateThemeToggle() {
    const isDark = document.documentElement.dataset.theme === "dark";
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.setAttribute("aria-checked", isDark ? "true" : "false");
      button.setAttribute("aria-label", isDark ? "Use light mode" : "Use dark mode");
    });
  }

  function applyTheme(theme) {
    const nextTheme = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.style.colorScheme = nextTheme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", nextTheme === "dark" ? "#000000" : "#ffffff");
    try {
      sessionStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      /* ignore quota / private mode */
    }
    updateThemeToggle();
  }

  function wireThemeToggle(root = app) {
    root.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      if (button.dataset.themeWired) {
        return;
      }
      button.dataset.themeWired = "true";
      button.addEventListener("click", () => {
        const nextTheme =
          document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        applyTheme(nextTheme);
      });
    });
    updateThemeToggle();
  }

  function getFeedLabel(feed = getCurrentFeed()) {
    const normalized = normalizeFeed(feed);
    if (normalized === FEED_TOP) {
      return "Top";
    }
    if (normalized === FEED_NEW) {
      return "New";
    }
    return "Best";
  }

  function getFeedPickerButton(feed) {
    const normalized = normalizeFeed(feed);
    const isActive = normalized === getCurrentFeed();
    return `
      <button
        class="btn feed-option${isActive ? " is-active" : ""}"
        type="button"
        data-feed-option="${normalized}"
        aria-pressed="${isActive ? "true" : "false"}"
        aria-label="Feed: ${getFeedLabel(normalized)}"
      >
        <span class="feed-option-label">${getFeedLabel(normalized)}</span>
      </button>
    `;
  }

  function updateFeedToggleLabels() {
    const normalized = normalizeFeed(getCurrentFeed());
    app.querySelectorAll("[data-feed-picker]").forEach((picker) => {
      picker.querySelectorAll("[data-feed-option]").forEach((button) => {
        const optionFeed = normalizeFeed(button.getAttribute("data-feed-option"));
        const isActive = optionFeed === normalized;
        button.classList.toggle("is-active", isActive);
        button.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
    });
  }

  function wireFeedToggleButtons(root = app) {
    root.querySelectorAll("[data-feed-option]").forEach((button) => {
      if (button.dataset.feedWired) {
        return;
      }
      button.dataset.feedWired = "true";
      button.addEventListener("click", () => {
        const next = button.getAttribute("data-feed-option");
        setFeed(next);
      });
    });
    updateFeedToggleLabels();
  }

  function topbar(content) {
    const leftContent = (content ?? "").trim();
    // List: feed picker on the left. Story/comments: back replaces the feeds.
    const startInner = leftContent
      ? leftContent
      : `<div class="feed-picker" role="group" aria-label="Story feed" data-feed-picker>
            ${FEEDS.map((feed) => getFeedPickerButton(feed)).join("")}
          </div>`;

    return `
      <header class="topbar">
        <div class="topbar-start">
          ${startInner}
        </div>
        <div class="topbar-actions">
          <button
            class="theme-toggle"
            type="button"
            role="switch"
            aria-checked="false"
            aria-label="Use dark mode"
            data-theme-toggle
          ></button>
        </div>
      </header>
    `;
  }

  return { readStoredTheme, applyTheme, wireThemeToggle, wireFeedToggleButtons, topbar };
}
