import { FEEDS } from "./config.js";

const feedLabels = { best: "Best", top: "Top", new: "New" };

export function createUI({ app, getCurrentFeed, setFeed }) {
  function getFeedTab(feed) {
    const isActive = feed === getCurrentFeed();
    return `
      <button
        class="feed-option"
        type="button"
        role="tab"
        id="feed-tab-${feed}"
        data-feed-option="${feed}"
        aria-controls="feed-panel"
        aria-selected="${isActive}"
        tabindex="${isActive ? 0 : -1}"
      >${feedLabels[feed]}</button>
    `;
  }

  function wireFeedToggleButtons(root = app) {
    const picker = root.querySelector("[data-feed-picker]");
    if (!picker) return;

    picker.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-feed-option]");
      if (!tab) return;
      const hadFocus = document.activeElement === tab;
      setFeed(tab.dataset.feedOption);
      if (hadFocus) document.getElementById(tab.id)?.focus({ preventScroll: true });
    });

    picker.addEventListener("keydown", (event) => {
      const tabs = Array.from(picker.querySelectorAll("[role=tab]"));
      const index = tabs.indexOf(event.target);
      if (index < 0 || event.altKey || event.ctrlKey || event.metaKey) return;

      let next;
      switch (event.key) {
        case "ArrowLeft":
          next = (index + tabs.length - 1) % tabs.length;
          break;
        case "ArrowRight":
          next = (index + 1) % tabs.length;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = tabs.length - 1;
          break;
        default:
          return;
      }

      event.preventDefault();
      tabs[index].tabIndex = -1;
      tabs[next].tabIndex = 0;
      tabs[next].focus();
    });

    picker.addEventListener("focusout", (event) => {
      if (picker.contains(event.relatedTarget)) return;
      const selectedTab = picker.querySelector('[aria-selected="true"]');
      event.target.tabIndex = -1;
      selectedTab.tabIndex = 0;
    });
  }

  function topbar(content = "") {
    const leftContent = content.trim() || `
      <div class="feed-picker" role="tablist" aria-label="Story feed" data-feed-picker>
        ${FEEDS.map(getFeedTab).join("")}
      </div>
    `;

    return `
      <header class="topbar">
        <div class="topbar-start">${leftContent}</div>
        <div class="topbar-actions">
          <button class="alerts-toggle" type="button" aria-label="Alerts" aria-haspopup="dialog" data-alerts>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
              stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>
            </svg>
          </button>
          <button
            class="theme-toggle"
            type="button"
            aria-label="Toggle theme"
            aria-pressed="${document.documentElement.dataset.theme === "light"}"
            data-theme-toggle
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
              stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path class="theme-moon" d="M20.9 13.4A9 9 0 0 1 10.6 3.1a9 9 0 1 0 10.3 10.3Z"/>
              <g class="theme-sun">
                <circle cx="12" cy="12" r="4"/>
                <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4"/>
              </g>
            </svg>
          </button>
        </div>
      </header>
    `;
  }

  return { wireFeedToggleButtons, topbar };
}
