# Confluence — Stock Opportunity Scanner

A personal technical-analysis dashboard: Bollinger Bands, moving averages (SMA20/50),
RSI, and Fibonacci retracement "golden zone" detection, computed across **4H, 1D, and
1W** timeframes for any stock you add, plus a curated "scan list" that's auto-ranked
every time you open the app so a strong setup doesn't slip past you.

This is a personal screening tool, **not financial advice** — it flags where price sits
relative to a handful of well-known technical signals, nothing more.

## How it works

- **Data**: pulled live from Yahoo Finance via the `yahoo-finance2` library (free,
  unofficial, no API key). 4H candles are built by aggregating hourly candles, since
  Yahoo doesn't offer a native 4H interval.
- **Scoring**: each timeframe gets a 0–100 "opportunity score" from:
  - RSI(14) — oversold/overbought
  - Bollinger Bands(20, 2σ) — price position within the bands
  - SMA20 vs SMA50 — trend context, and healthy pullbacks toward the average
  - Fibonacci retracement — is price sitting in the 61.8%–65% "golden pocket" of the
    most recent swing?
  - The three timeframes are then blended (Weekly 40% / Daily 35% / 4H 25%) into one
    overall score, shown as the gold dial on each card.
- **Storage**: your watchlist and scan list are saved server-side via Netlify Blobs, so
  they persist across devices as long as you're using the same deployed site.
- **Alerts**: currently visual only — open the app and anything scoring high is sorted
  to the top of your scan list and highlighted with a gold border. (Email/push alerts
  can be added later without changing this architecture.)

## Deploying to Netlify

Because this app uses serverless functions with npm dependencies, **connect it as a Git
repository** rather than drag-and-drop uploading the folder — Netlify needs to run
`npm install` during its build so the functions have their dependencies.

1. Push this folder to a new GitHub repo (or GitLab/Bitbucket).
2. In Netlify: **Add new site → Import an existing project**, pick the repo.
3. Build settings should auto-fill from `netlify.toml`:
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
   - Build command: `npm install`
4. Deploy. Netlify Blobs works automatically on deployed sites — no extra setup needed.
5. Open the site on your phone and add it to your home screen (Safari: Share → Add to
   Home Screen; Chrome/Android: menu → Add to Home screen) so it behaves like an app.

## Adding stocks

Use the "Add ticker" field in the header — choose **My Watchlist** for stocks you're
personally tracking, or **Scan List** for stocks you want automatically monitored and
ranked alongside whatever else is already there.

## Known limitations / things to keep an eye on

- `yahoo-finance2` is unofficial — if Yahoo changes something, data fetches could break
  until the library is updated (check for library updates if you start seeing errors).
- 4H candles are built from hourly bars grouped by wall-clock time, not by market
  session — this is a simplification, fine for spotting setups but not exact.
- The scoring weights (RSI/BB/MA/Fib) are a reasonable starting framework, not a
  backtested strategy. Feel free to tune the numbers in
  `netlify/functions/lib/analysis.js` as you learn what works for you.
- No real-time push notifications yet since alerts are visual-only for now.
