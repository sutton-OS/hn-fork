# HNx

Lightweight vanilla JS/CSS Hacker News client, built with a privacy-first browser surface.

## Privacy posture

- **No accounts, cookies, analytics, or ads**
- **Self-hosted fonts** (no Google Fonts)
- **Browser → first party only** for HN data (`/api/*`)
- **Publisher favicons** in the full app come from Google’s favicon service with no referrer
- **Vendored DOMPurify** for comment/HTML sanitization (no CDN)
- **Strict security headers** (CSP, HSTS, Referrer-Policy, Permissions-Policy, COOP/CORP)
- **Restricted article and image fetches** use public addresses, bounded responses, and per-IP rate limits
- **Saved articles and recent feeds** are stored on the device for offline reading
- **Theme** uses tab `sessionStorage` only (so the privacy page matches light/dark)
- **No-JS**: plain HTML reader at [`/plain`](https://hn-fork.vercel.app/plain) (server-rendered)
- **Classic 90s skin**: bare HTML blue-links mode at [`/classic`](https://hn-fork.vercel.app/classic) (double-tap `H` from the modern app)
- See [`public/privacy.html`](public/privacy.html) for the user-facing policy

## Structure

- `public/` — static UI (`index.html`, `app.js`, `styles.css`, vendored libs, fonts)
- `public/modules/` — native ES modules for routing, API/cache, feeds, stories, comments, shared UI, and sanitization
- `api/` — Vercel serverless endpoints (`stories`, `item`, `thread`, `reader`, `image`, `html/*`)
- `lib/hn.js` — shared HN fetch/normalize helpers for API routes
- `lib/html.js` — HTML escaping, parser-based `sanitize-html` sanitizer, and plain-reader layout helpers
- `test/` — unit/API regression tests and desktop/mobile Playwright tests

## Plain HTML (no JavaScript)

```
/plain              → best feed
/plain/top          → top feed
/plain/new          → new feed
/plain/item/:id     → story or comment + paged replies
```

Theme without JS: `?theme=light` or `?theme=dark` (linked in the top bar).

## Classic HTML (90s skin)

Bare-bones reader: browser defaults, blue links, no panels or custom fonts.

```
/classic            → best feed
/classic/top        → top feed
/classic/new        → new feed
/classic/item/:id   → story or comment + paged replies
```

From the modern app, **double-tap `H`** jumps to the matching classic page (feed or current item).

## Run locally

Use Node 24.15 or later in the Node 24 line (the pinned production runtime).

Use Vercel dev when you need the API routes:

```sh
npm ci
vercel dev
```

For a static-only UI smoke check:

```sh
python3 -m http.server 8080 -d public
```

## Test / check

```sh
npm ci
npx playwright install chromium
npm test              # helper, API failure/retry, and client cache regressions
npm run check         # syntax-check all JavaScript and verify vendored DOMPurify
npm run test:browser  # desktop and mobile Chromium, using deterministic local HN fixtures
npm run verify        # all checks above
```

Browser tests exercise the real API handlers and configured security headers. They cover native keyboard controls, retry flows, nested pagination, cache freshness, deep-thread layout, sanitization, and plain/classic readers with JavaScript disabled. GitHub Actions runs verification on Node 22 and 24.

## Dependency updates

Dependencies are pinned in `package.json` and `package-lock.json`; Dependabot checks npm packages weekly. DOMPurify runs in the browser from a self-hosted, versioned file loaded with the discussion view. After updating it, update its filename reference in `public/modules/sanitize.js`, then run `npm run vendor:sync` and `npm run verify`. Remove the previous vendored distribution when switching versions. The same command creates a CommonJS server sanitizer bundle in `lib/vendor/`, including license notices, because Vercel cannot load its ESM parser through CommonJS. Run it after any sanitizer or transitive dependency update. `npm run check` rejects any vendored distribution, license, or server sanitizer bundle that differs from the locked packages.

## Data loading

Vercel caches successful standard first-page feed responses for 20 seconds. The modern feed loads 12 stories first and waits for scrolling when that page already fills the viewport. A direct discussion streams the title and story text before comments finish loading, using one request to Hacker News for the parent. Hover prefetches wait for sustained pointer intent and are capped at two in flight. Completed prefetches expire after 30 seconds and are consumed once. Opening prefetched comments fetches current story details in parallel.

Story and comment pages fail on upstream fetch errors instead of silently skipping unavailable items. Retry controls preserve the failed page; genuine missing/deleted items still advance pagination. Each reply list owns its pagination cursor and deduplicates comment IDs across pages. Revisiting a discussion refreshes its comments. Comment indentation adds 14 pixels per level through depth six, then stops.

## Saved and offline

Use the bookmark button on any feed story and open it from **Saved**. For HN discussions without an external article, the copy contains the original post text when available. The 200-story prompt lets you confirm saving another story. Removing a bookmark deletes its text and images. The Saved footer reports the browser’s estimated storage usage for the HNx origin.

After the service worker installs, the shell and visited feed pages are available offline. Only first-party feed responses are cached by the worker. Saved article text and images live in IndexedDB. Bump the `shell-vN` constant in `public/sw.js` on shell releases and update the precache URLs whenever an asset version changes.

## Deploy

Deploy on Vercel. Static files live in `public/`, and serverless endpoints live in `api/`. There is no build step.

Run `npm run verify` before `vercel --prod`. The linked Vercel project uses Node 24 and installs the locked runtime dependencies for article extraction and sanitization. Deploy the static files, API functions, and `vercel.json` together. The Vercel config enables [CommonJS loading of ES modules](https://vercel.com/docs/functions/runtimes/node-js/advanced-node-configuration#experimental-node.js-require-of-es-module) for jsdom’s dependencies.

The reader and image functions enforce per-IP limits of 20 and 160 requests per minute per function instance. Set a [Vercel Firewall rate-limit rule](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting) keyed by IP for `/api/reader` and `/api/image` for a shared limit across instances. Where the plan supports only one rule, match both paths and use a combined limit of 180 requests per minute.

## Keyboard

**Anywhere (modern app)**

- Double-tap `H` — open classic 90s HTML skin for the current feed/item

Shortcuts leave focused links, buttons, form fields, and editable content to their native keyboard behavior.

**List view**

- `j` / `k` or arrows — move selection
- `Enter` — open article
- `c` — open discussion
- `g` / `G` — first / last story

**Story / comments**

- `j` / `k` or arrows — move comment selection
- `Enter` — expand replies on selected comment
- `h` — collapse / expand selected comment (single tap; double-tap opens classic)
- `g` / `G` — first / last visible comment
