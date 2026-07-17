# Confluence — Stock Opportunity Scanner

A personal technical-analysis dashboard: Bollinger Bands, moving averages (SMA20/50/200),
RSI, and Fibonacci retracement "golden zone" detection, computed across **4H, 1D, and
1W** timeframes for any stock you add, plus a curated "scan list" that's auto-ranked
every time you open the app so a strong setup doesn't slip past you.

This is a personal screening tool, **not financial advice** — it flags where price sits
relative to a handful of well-known technical signals, nothing more.

## How it works

- **Data**: pulled from [Twelve Data](https://twelvedata.com)'s free tier — a
  documented, key-based API (800 requests/day, 8 requests/minute). Each stock uses 2
  API credits: one call for native 4H candles, one for daily candles. Weekly candles
  are derived locally from the daily data (grouped into Monday-start weeks) rather than
  spending a third credit.
  - *(Earlier versions used the unofficial `yahoo-finance2` library. It was switched
    out after Yahoo's authentication endpoint started intermittently returning 429
    errors for everyone using that library — a
    [widely-reported, ongoing issue](https://github.com/gadicc/yahoo-finance2/issues/977),
    not something fixable from this app's side.)*
- **Scoring**: each timeframe gets a 0–100 "opportunity score" from:
  - RSI(14) — oversold/overbought
  - Bollinger Bands(20, 2σ) — price position within the bands
  - SMA20 vs SMA50 — trend context, and healthy pullbacks toward the average
  - SMA200 — long-term trend context (only shown once there's enough history)
  - Fibonacci retracement — is price sitting in the 61.8%–65% "golden pocket" of the
    most recent swing?
  - The three timeframes are then blended (Weekly 40% / Daily 35% / 4H 25%) into one
    overall score, shown as the gold dial on each card.
- **Storage**: your watchlist and scan list are saved server-side via Netlify Blobs, so
  they persist across devices as long as you're using the same deployed site.
- **Pacing**: to stay under the free tier's 8 requests/minute cap, the app dispatches
  one new stock scan roughly every 16 seconds rather than firing them all at once.
  Cards fill in gradually — this is expected, not a bug.
- **Alerts**: currently visual only — open the app and anything scoring high is sorted
  to the top of your scan list and highlighted with a gold border. (Email/push alerts
  can be added later without changing this architecture.)

## Required setup: Twelve Data API key

This app won't work without this step — it's a 2-minute signup, no credit card needed.

1. Go to [twelvedata.com](https://twelvedata.com) and sign up for a free account.
2. Find your API key on your account dashboard.
3. In Netlify: your site → **Site configuration → Environment variables → Add a variable**.
   - Key: `TWELVE_DATA_API_KEY`
   - Value: (paste your key)
4. Trigger a redeploy (**Deploys → Trigger deploy → Deploy site**) so the function picks
   up the new variable.

If this variable is missing, every stock will fail to load with a clear error message
telling you so (rather than failing silently).

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
4. Add the `TWELVE_DATA_API_KEY` environment variable (see above) before or right after
   the first deploy.
5. Deploy. Netlify Blobs works automatically on deployed sites — no extra setup needed.
6. Open the site on your phone and add it to your home screen (Safari: Share → Add to
   Home Screen; Chrome/Android: menu → Add to Home screen) so it behaves like an app.

## Adding stocks

Use the "Add ticker" field in the header — choose **My Watchlist** for stocks you're
personally tracking, or **Scan List** for stocks you want automatically monitored and
ranked alongside whatever else is already there.

Keep in mind the free tier's daily cap (800 requests = ~400 full stock scans/day) — for
personal use, checking the app a handful of times a day with a reasonable watchlist size
comfortably fits within that.

## Known limitations / things to keep an eye on

- Free-tier rate limits mean loading is intentionally paced (~4 stocks/minute) — a
  watchlist of 10+ stocks will take a couple of minutes to fully populate on open.
- If you see a "rate limit" error on a card, the app already retries once automatically
  after a short wait — if it still fails, just hit "Rescan" a little later.
- The scoring weights (RSI/BB/MA/Fib) are a reasonable starting framework, not a
  backtested strategy. Feel free to tune the numbers in
  `netlify/functions/lib/analysis.js` as you learn what works for you.
- Weekly candles are derived from daily data grouped into Monday-start weeks — this is
  a simplification of true exchange trading weeks but close enough for spotting setups.
- No real-time push notifications yet since alerts are visual-only for now.
