# HNx

Lightweight vanilla JS/CSS Hacker News client, built with a privacy-first browser surface.

## Privacy posture

- **No accounts, cookies, analytics, or ads**
- **Optional push alerts** use a per-browser subscription and server-side rules that can be deleted from the Alerts panel
- **Self-hosted fonts** (no Google Fonts)
- **Browser → first party only** for HN data (`/api/*`)
- **Publisher favicons** in the full app come from Google’s favicon service with no referrer
- **Vendored DOMPurify** for comment/HTML sanitization (no CDN)
- **Strict security headers** (CSP, HSTS, Referrer-Policy, Permissions-Policy, COOP/CORP)
- **Article previews and offline copies** resolve publisher URLs from Hacker News items
- **Saved articles and recent feeds** are stored on the device for offline reading
- **Theme and preview decisions** use tab `sessionStorage` only (so the privacy page matches light/dark)
- **No-JS**: plain HTML reader at [`/plain`](https://hn-fork.vercel.app/plain) (server-rendered)
- **Classic 90s skin**: bare HTML blue-links mode at [`/classic`](https://hn-fork.vercel.app/classic) (double-tap `H` from the modern app)
- See [`public/privacy.html`](public/privacy.html) for the user-facing policy

## Structure

- `public/` — static UI (`index.html`, `app.js`, `styles.css`, vendored libs, fonts)
- `public/modules/` — native ES modules for routing, API/cache, feeds, stories, comments, shared UI, and sanitization
- `api/` — Vercel serverless endpoints for HN data, previews, and push alerts
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

Use Node 24 (the pinned production runtime).

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

Vercel caches successful standard first-page feed responses for 20 seconds, then may serve that copy for up to five more minutes while it fetches a new one. The modern feed loads 12 stories first and waits for scrolling when that page already fills the viewport. If the device stored that page within the last hour, it appears right away and the live page follows. Pull to refresh skips both copies.

Opening a discussion keeps the feed's rows and scroll position for going back. Returning to the app after a minute checks for new stories. They replace the rows only when the reader is at the top and has not started using the list; otherwise a button offers them.

A direct discussion streams the title and story text before comments finish loading, using one request to Hacker News for the parent. A discussion opened from the feed shows the row's title at once. Discussions and replies start loading on sustained hover or on press, with at most two requests in flight; leaving or scrolling cancels them. Completed prefetches expire after 30 seconds and are consumed once. Opening prefetched comments fetches current story details in parallel.

Story and comment pages fail on upstream fetch errors instead of silently skipping unavailable items. Retry controls preserve the failed page; genuine missing/deleted items still advance pagination. Each reply list owns its pagination cursor and deduplicates comment IDs across pages. Revisiting a discussion refreshes its comments. Comment indentation adds 14 pixels per level through depth six, then stops.

## Saved and offline

Use the bookmark button on a feed story and open it from **Saved**. After the service worker installs, recently visited feed pages and saved copies are available offline. Saved text and images live in IndexedDB. Removing a bookmark deletes its copy. The Saved footer shows the browser’s estimated storage usage for the HNx origin.

The offline Reader retrieves the article and up to eight images in one request using its HN item ID. Bump the `shell-vN` constant in `public/sw.js` and update the asset list when releasing shell changes.

## Deploy

Deploy on Vercel. Static files live in `public/`, and serverless endpoints live in `api/`. There is no build step.

Run `npm run verify` before `vercel --prod`. The linked Vercel project uses Node 24 and installs the locked runtime dependencies. Deploy the static client, functions, `vercel.json`, and lockfile together. Push alerts use the configuration below.

## Push alerts

Upstash Redis stores subscriptions and alert history. A Cloudflare Cron Trigger calls the existing Vercel deployment every ten minutes (`*/10 * * * *`, UTC).

Create an Upstash Redis database for the production site. Configure these values in the Vercel project's **Production** environment and redeploy. Enable Fluid Compute for the scheduled function's configured 180-second duration.

| Vercel variable | Value |
| --- | --- |
| `ALERTS_ORIGIN` | The canonical HTTPS site origin, such as `https://hn-fork.vercel.app`, without a trailing slash. The Alerts API accepts browser writes from this origin. |
| `VAPID_PUBLIC_KEY` | Public key from `npx web-push generate-vapid-keys`. The client reads it from `GET /api/subscribe`. |
| `VAPID_PRIVATE_KEY` | Private key from the same command. Save it as a secret and retain the key pair across deployments. |
| `VAPID_SUBJECT` | A monitored contact address, such as `mailto:alerts@example.com`. |
| `UPSTASH_REDIS_REST_URL` | The Upstash Redis HTTPS REST endpoint. |
| `UPSTASH_REDIS_REST_TOKEN` | The Redis write token, stored as a secret. |
| `CRON_SECRET` | A shared secret of at least 32 characters. Generate it with `openssl rand -hex 32` and store the same value in Vercel and Cloudflare. |

1. Configure the Cloudflare Worker in [scheduler/wrangler.toml](scheduler/wrangler.toml). Set `ALERTS_ORIGIN` to the same site origin as Vercel and add `CRON_SECRET` as a Worker secret. The Worker sends it as a bearer token to `GET /api/alert-job`.
2. Deploy from the repository root with Wrangler. The first secret command can prompt you to create the Worker if it does not exist. Replace the example origin in the deploy command if needed.

   ```sh
   npx wrangler secret put CRON_SECRET --config scheduler/wrangler.toml
   npx wrangler deploy --config scheduler/wrangler.toml --var ALERTS_ORIGIN:https://hn-fork.vercel.app
   ```

3. If the deployment uses egress filtering, allow HTTPS to the configured push providers, including `*.push.apple.com`. Verify the next scheduled invocation in Cloudflare and look for `HNx alerts run` in Vercel logs.

On iOS and iPadOS 16.4 or later, install HNx on the Home Screen and open the installed app before enabling notifications. Other browsers can use alerts wherever they support Web Push. A rule matches any of its keyword terms as a whole word. Double quotes match the enclosed phrase and a domain filter includes its subdomains. The first scan can alert on stories already at or above the threshold in the current top, best, or new feed. Each story is deduplicated for seven days. A summary counts toward the rolling five-per-hour limit, along with individual and test notifications. New matches wait for the next scan with available capacity if all slots have been used.

The API uses short-lived per-IP rate counters keyed by a one-way digest. Deleting alerts removes the subscription, rules, and its delivery history. The scheduler reserves deliveries before sending so retries and overlapping runs cannot send the same story again. A reservation is kept if the push provider's response leaves delivery uncertain.

To exercise the Redis scripts with an isolated local Redis instance, set `HNX_REDIS_SERVER` to the path of `redis-server` (with `redis-cli` next to it) and run `node --test test/alerts.test.js`. For device acceptance, send a test with the installed app in the background, check the lock screen and icon badge, then tap a matching story notification with the app open and again after closing it.

## Mobile link previews

External headlines open the publisher directly when HNx runs from the iOS or iPadOS Home Screen. On other coarse-pointer screens up to 768px wide, external headlines in the modern feed open a bottom sheet. The sheet keeps the selected row, scroll position, and a Back entry. The header offers the original link in every mode. The plain and classic skins keep their native links.

The sheet requests Reader while it checks whether the publisher can be embedded. If the live site is still loading after two seconds, the sheet shows Reader as soon as it is available and offers a Site toggle if the live page finishes loading.

`GET /api/embeddable?id=…` checks final publisher headers with HEAD and a bounded GET fallback. `GET /api/reader?id=…` extracts public HTML with Readability and sanitizes it with DOMPurify in a time-limited jsdom worker. Both endpoints resolve the publisher link from the Hacker News item identified by `id`. Publisher requests use vetted public addresses, and the eight-second budget covers the item lookup and preview. Warm function instances cache frame decisions for 24 hours and reader results for up to one hour, and limit each client IP to 40 requests per minute per instance. A domain cache entry is reused only for the same URL because paths can have different frame policies, redirects, or content types.

Known media and file extensions use native links. For extensionless files discovered by the server, the sheet opens a tab when the browser permits it and otherwise provides an explicit link.

## Keyboard

**Anywhere (modern app)**

- Double-tap `H` — open classic 90s HTML skin for the current feed/item

Shortcuts leave focused links, buttons, form fields, and editable content to their native keyboard behavior.

**List view**

- `j` / `k` or arrows — show or move selection
- `Enter` — open article
- `c` — open discussion
- `g` / `G` — first / last story

**Story / comments**

- `j` / `k` or arrows — move comment selection
- `Enter` — expand replies on selected comment
- `h` — collapse / expand selected comment (single tap; double-tap opens classic)
- `g` / `G` — first / last visible comment
