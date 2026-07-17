# HNx

Lightweight vanilla JS/CSS Hacker News client, built with a privacy-first browser surface.

## Privacy posture

- **No accounts, cookies, analytics, or ads**
- **Self-hosted fonts** (no Google Fonts)
- **Browser → first party only** for HN data (`/api/*`); no client calls to Firebase/Algolia/Google
- **Vendored DOMPurify** for comment/HTML sanitization (no CDN)
- **Strict security headers** (CSP, HSTS, Referrer-Policy, Permissions-Policy, COOP/CORP)
- **No open URL-fetch proxy**
- See [`public/privacy.html`](public/privacy.html) for the user-facing policy

## Structure

- `public/` — static UI (`index.html`, `app.js`, `styles.css`, vendored libs, fonts)
- `api/` — Vercel serverless endpoints (`stories`, `item`, `thread`)
- `lib/hn.js` — shared HN fetch/normalize helpers for API routes

## Run locally

Use Vercel dev when you need the API routes:

```sh
vercel dev
```

For a static-only UI smoke check:

```sh
python3 -m http.server 8080 -d public
```

## Deploy

Deploy on Vercel. Static files live in `public/`, and serverless endpoints live in `api/`. There is no build step.

## Keyboard

**List view**

- `j` / `k` or arrows — move selection
- `Enter` — open article
- `c` — open discussion
- `g` / `G` — first / last story

**Story / comments**

- `j` / `k` or arrows — move comment selection
- `Enter` — expand replies on selected comment
- `h` — collapse / expand selected comment
- `g` / `G` — first / last visible comment
