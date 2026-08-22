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
  - **RSI divergence** — compares the two most recent comparable swing points in price
    against RSI at those same points. Bearish divergence: price makes a *higher high*
    while RSI makes a *lower high* (momentum fading even as price pushes up — often an
    early warning before a top). Bullish divergence: price makes a *lower low* while
    RSI makes a *higher low* (selling momentum fading before a bottom). Divergence is
    detected using swing/fractal pivots (a point must be the local max/min within a
    7-bar window to count), which means it's inherently a few bars delayed — it can't
    flag a divergence at the very latest bar, only once a swing point is confirmed by
    a bit of price action afterward.
  - **Volume trend** — compares average volume over the last 5 bars against the 5
    before that. Used mainly to confirm (or not) a divergence signal: declining volume
    on the rally that produced a bearish divergence, or declining volume on the decline
    that produced a bullish divergence, adds extra weight to the score and the guidance
    text explicitly calls this out when it applies.
  - Fibonacci retracement — is price sitting in the 61.8%\u201378.6% "golden zone" of
    the most recent swing? (Widened from the narrower 61.8\u201365% "pocket" some
    traders use — 78.6% is the level most technical analysts treat as the practical
    limit of a valid pullback; beyond it, the trend is generally considered
    structurally broken rather than just pausing.) Daily and weekly retracements are
    calculated on a **log scale** rather than linear — this matters most for stocks
    that have moved a large percentage (e.g. $8 to $80), where straight dollar-based
    retracement can land noticeably differently from where price has actually reacted
    historically. 4H uses linear scale, since shorter-term moves are rarely large
    enough for the difference to matter. Each card also shows **extension targets**
    (127.2%, 161.8%, 227.2%, 261.8%) — a separate calculation projecting where price
    might head if the move continues *past* the swing, rather than where a pullback
    might stall. Extensions always use log scale too (regardless of the retracement's
    own setting) — a linear calculation can subtract more dollars than the anchor
    price actually has for a stock that's moved a very large percentage, producing a
    mathematically impossible negative "price." Log scale structurally cannot do that.
  - **Cross-timeframe golden-zone context**: a single timeframe's swing high/low can't
    tell apart two very different situations that look identical in isolation — a
    "pullback support" zone that's genuinely a dip within a bigger uptrend, versus one
    that's just a brief pause within a bigger downtrend (support likely to fail); or a
    "bounce resistance" zone within a downtrend that's likely to fail and resume the
    decline, versus one that's actually a genuine reclaim within a bigger uptrend. 4H
    and daily now check the **weekly timeframe's own trend direction** (simple 20/50 MA
    comparison) to tell these apart, and discount or boost the golden-zone score
    accordingly — a "bounce" zone that the weekly trend confirms as a downtrend gets
    heavily discounted (and flagged as caution, not bullish), while one weekly
    contradicts gets a more moderate read. Weekly's own zone check has no higher
    timeframe to compare against, so it's unaffected. If weekly data is insufficient,
    no discount is applied (we don't guess when we don't have a basis to).
  - The three timeframes are then blended (Weekly 40% / Daily 35% / 4H 25%) into one
    overall score, shown as the gold dial on each card.
- **Storage**: your watchlist and scan list are saved server-side via Netlify Blobs, so
  they persist across devices as long as you're using the same deployed site.
- **Plain-English guidance**: each card includes a couple of auto-generated sentences
  translating the numbers into something actionable — e.g. "price is 7% below the
  golden zone, watch for a rally into that range" — plus a concrete invalidation level
  (the swing low that, if broken, means the setup no longer holds).
- **Earnings check (opt-in, manual only)**: a "Check earnings date" button on each card
  looks up the next earnings date via Twelve Data's `/earnings` endpoint. This is
  **never called automatically** — only on click — because this endpoint's exact
  credit cost couldn't be confirmed ahead of time, and fundamentals-style endpoints on
  Twelve Data can cost far more than the 1 credit/call used for price data (their docs
  show some fundamentals endpoints at 100 credits/symbol). Results are cached 24 hours
  per symbol to avoid paying for the same check twice. **The first time you use this,
  check your Twelve Data usage dashboard afterward** to see what it actually cost
  before relying on it for many stocks.
- **P/E ratio check (opt-in, manual only)**: a "Check P/E ratio" button on each card
  looks up trailing/forward P/E via **Yahoo Finance** (`yahoo-finance2`'s `quote()`
  method), not Twelve Data — P/E and other fundamentals aren't available at all on
  Twelve Data's free tier (that data starts at their paid "Grow" plan). Yahoo's
  unofficial API is known to be intermittently unreliable (see the note in git history
  about the crumb/429 issue that caused a full outage earlier in this project) — this
  feature is deliberately isolated in its own function (`pe-ratio.js`) so that if Yahoo
  has problems again, it only breaks this one button, never the core Twelve
  Data-based scanning. Results are cached 24 hours per symbol.
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

## Rolling back the long-range major zones feature

Each daily/weekly timeframe panel now also shows a **second, separate** ladder —
"Major support/resistance (long-term)" — built differently from the short-term one
above it. Instead of the most recent 60-90 bars, it scans as much history as we have
(up to ~3 years of daily, ~5 years of weekly) for pivot highs/lows, clusters ones that
land within 2% of each other, and ranks by how many times that price area was actually
retested. A "Fib golden zone (long-term)" row was also added, using the same
long-range window instead of the existing short-term Fibonacci calculation, so you can
compare both. 4H has no long-range pass — only ~200 days are fetched for it, not
enough history for "major" to mean anything.

A touch only counts as a genuinely separate test of a level if **both** of these hold:
1. Price actually departed the zone (moved at least 2.5× the cluster tolerance away)
   and came back, rather than just producing another nearby pivot a few bars later —
   otherwise a single choppy stretch can look like many independent tests.
2. The touches span at least 15% of the total lookback window — otherwise a handful of
   genuine oscillations packed into one short early period (e.g. 8 touches in 60 days,
   out of a 750-day window) can outrank a level that's actually proven itself over a
   much longer, more relevant stretch of time.

Both conditions were added after testing against a synthetic case that reproduced a
real issue: an early, tight consolidation period was surfacing as a "21× tested" major
level despite being a single short-lived event, decades of price action and hundreds
of dollars away from current price. That fix worked for a short, isolated
consolidation, but real testing against META surfaced a **second, deeper issue**: even
with those two conditions, a long, noisy multi-year decline-then-recovery (like META's
actual 2021-2024 history) could still produce inflated counts (9, 7, 6 touches),
because grinding sideways *through* a price band during one long trending move can
satisfy both the "departed and returned" and "spans enough time" checks without
representing genuinely separate visits months apart.

The fix that actually resolved this replaced pivot-clustering-based counting entirely
with a **price-crossing state machine**: for each candidate price zone, walk the full
close series in time order and only count a touch when price was clearly away from the
zone (beyond a buffer) for a meaningful stretch (~10 bars, roughly 2 weeks of daily
data), then genuinely re-entered. This is a fundamentally more direct measurement of
"how many separate times did price actually come back to this level" than trying to
infer it from where pivots happened to land. Retested against all three scenarios
together: the short consolidation still correctly returns nothing, the noisy
long-grind META-like case now returns realistic low counts (2× each) instead of the
inflated 9/7/6, and the genuine multi-month oscillation pattern still correctly shows
~4 touches on each side.

Real-world testing against AMAT and META surfaced **two more issues** on top of that:
support levels 60-90% below current price with double-digit touch counts (e.g. $50 for
a stock at $496). Two causes, both fixed:
1. Touches genuinely 3+ weeks apart can still all cluster within one relatively short
   (few-month) volatile period — like the choppy re-basing right after a crash — rather
   than being spread across a level's whole history. Added a **minimum span
   requirement**: touches must spread across at least 20% of the total lookback window
   to count as a proven long-term level, not just a busy few months.
2. Even a genuinely, repeatedly-tested old level isn't practically useful if a stock
   has moved several multiples away from it since. Added a **maximum distance cap**
   (40% from current price) — a level further away than that simply isn't surfaced,
   rather than showing something technically real but not actionable.

Worth knowing: with this cap in place, many stocks — especially ones that have run up
or down a lot from any historically-significant level — will now often show **no**
major zones on one or both sides. That's the intended, honest outcome (nothing nearby
qualifies) rather than a bug; the short-term ladder above it still always has
Bollinger/MA/Fibonacci-based levels regardless.

**A fourth round, prompted by testing GOOG**: a smoothly, steadily trending stock (less
back-and-forth than META's choppy post-crash recovery) genuinely produced *zero*
levels near current price meeting the "2+ genuine crossings" bar — not because of a
bug, but because a steady climb naturally creates fewer repeated revisits of the same
price band than a more volatile stock does. Diagnostic testing confirmed every
candidate within 40% of price had exactly 1 crossing, while the only 2+-crossing
candidates were 70%+ away (correctly excluded by the distance cap). Shortening the
lookback window (the initially-proposed fix) was tested and confirmed **not** to help,
since the bottleneck was touch count, not span.

The actual fix: a **two-tier system**. The strict "Major level" bar (2+ genuine
crossings, spread across 20%+ of the window) stays the primary, preferred result
whenever anything clears it — confirmed still working correctly on the SOFI-style
genuine-oscillation test. When nothing does, it falls back to showing the nearest
single genuine test as a **"Notable level (tested once)"** — same price-crossing logic,
just without requiring a second visit. The frontend styles this fallback tier visibly
dimmer (dashed border, lighter text) so a single test is never visually confused with a
level that's actually proven itself multiple times. Retested against all four
scenarios together (GOOG-like smooth climb, META-like volatile recovery, the original
short-consolidation bug, and the genuine SOFI-style oscillation) to confirm each now
gets the right tier.

`backups/analysis.js.before-major-zones`, `app.js.before-major-zones`,
`index.html.before-major-zones`, and `styles.css.before-major-zones` are the versions
from right before this whole feature existed — still the right rollback target if
needed (there's no separate backup for the specific version with the touch-counting
bug, since that version was actively wrong, not a worthwhile revert target). To revert:

```bash
cp backups/analysis.js.before-major-zones netlify/functions/lib/analysis.js
cp backups/app.js.before-major-zones public/app.js
cp backups/index.html.before-major-zones public/index.html
cp backups/styles.css.before-major-zones public/styles.css
git add . && git commit -m "Revert long-range major zones" && git push
```

## Rolling back the multi-zone support/resistance ladder

Each timeframe panel now shows up to 4 support levels (below current price) and 4
resistance levels (above it), sourced from both Fibonacci golden zones (not just
whichever direction the swing happened to run), extensions in both directions,
Bollinger Bands, moving averages, and recent swing pivots — sorted nearest-to-price
first. A level's role (support vs. resistance) is derived fresh from its position
relative to current price every scan, not baked into swing history, so a broken
support level automatically "acts as" resistance the next time price approaches it
from below, with no special-case code needed for that. This is the simple version
(every candidate shown as-is) — merging levels that cluster close together into a
single "confluence" entry is a possible future improvement if the list feels
cluttered in practice.

`backups/analysis.js.before-multizone-ladder`, `app.js.before-multizone-ladder`,
`index.html.before-multizone-ladder`, and `styles.css.before-multizone-ladder` are
the versions from right before this feature. To revert:

```bash
cp backups/analysis.js.before-multizone-ladder netlify/functions/lib/analysis.js
cp backups/app.js.before-multizone-ladder public/app.js
cp backups/index.html.before-multizone-ladder public/index.html
cp backups/styles.css.before-multizone-ladder public/styles.css
git add . && git commit -m "Revert multi-zone ladder" && git push
```

## Rolling back the cross-timeframe golden-zone scoring change

`backups/analysis.js.before-cross-timeframe-context` is the exact version of
`netlify/functions/lib/analysis.js` from right before the cross-timeframe context
feature was added (see above). If that change causes problems, you can revert by
copying it back over the live file:

```bash
cp backups/analysis.js.before-cross-timeframe-context netlify/functions/lib/analysis.js
git add . && git commit -m "Revert cross-timeframe golden-zone scoring" && git push
```

This file lives outside `netlify/functions/` on purpose (it's in a root-level
`backups/` folder) so Netlify never mistakes it for a deployable function.

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
