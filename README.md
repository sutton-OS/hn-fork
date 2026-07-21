# HNx

Lightweight vanilla JS/CSS Hacker News client, built with a privacy-first browser surface.

## Privacy posture

- **No accounts, cookies, analytics, or ads**
- **Self-hosted fonts** (no Google Fonts)
- **Browser → first party only** for HN data (`/api/*`); no client calls to Firebase/Algolia/Google
- **Vendored DOMPurify** for comment/HTML sanitization (no CDN)
- **Strict security headers** (CSP, HSTS, Referrer-Policy, Permissions-Policy, COOP/CORP)
- **No open URL-fetch proxy**
- **Theme** uses tab `sessionStorage` only (so the privacy page matches light/dark)
- **No-JS**: plain HTML reader at [`/plain`](https://hn-fork.vercel.app/plain) (server-rendered)
- **Classic 90s skin**: bare HTML blue-links mode at [`/classic`](https://hn-fork.vercel.app/classic) (double-tap `H` from the modern app)
- See [`public/privacy.html`](public/privacy.html) for the user-facing policy

## Structure

- `public/` — static UI (`index.html`, `app.js`, `styles.css`, vendored libs, fonts)
- `api/` — Vercel serverless endpoints (`stories`, `item`, `thread`, `html/*`)
- `lib/hn.js` — shared HN fetch/normalize helpers for API routes
- `lib/html.js` — HTML escape/sanitize + plain-reader layout helpers

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

Use Vercel dev when you need the API routes:

```sh
vercel dev
```

For a static-only UI smoke check:

```sh
python3 -m http.server 8080 -d public
```

## Test / check

```sh
npm test    # unit tests for lib/hn + lib/html
npm run check  # syntax-check API + client entrypoints
```

## Deploy

Deploy on Vercel. Static files live in `public/`, and serverless endpoints live in `api/`. There is no build step.

## Keyboard

**Anywhere (modern app)**

- Double-tap `H` — open classic 90s HTML skin for the current feed/item

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
