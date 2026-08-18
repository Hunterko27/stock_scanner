const { RSI, BollingerBands, SMA } = require('technicalindicators');

const TWELVE_DATA_BASE = 'https://api.twelvedata.com/time_series';
const API_KEY = process.env.TWELVE_DATA_API_KEY;

// Wraps a promise with a hard timeout so a slow/hung request can never block
// the whole function past Netlify's own execution limit.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out fetching ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------- Data fetching (Twelve Data) ----------

async function fetchSeries(symbol, interval, outputsize, label) {
  if (!API_KEY) {
    throw new Error('Server is missing TWELVE_DATA_API_KEY — add it in Netlify site settings (see README).');
  }

  const url = `${TWELVE_DATA_BASE}?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${API_KEY}`;
  const res = await withTimeout(fetch(url), 8000, `${symbol} ${label}`);
  const data = await res.json();

  if (data.status === 'error' || data.code >= 400) {
    // Free tier allows 8 requests/minute. Retrying with an in-function sleep
    // is a trap here — Netlify's synchronous functions have their own ~10s
    // execution limit, and a multi-second sleep-then-retry can blow past
    // that and get the whole function killed before it can even respond.
    // Instead, fail fast with a distinct error the client can recognize and
    // retry later, outside the function's time budget entirely.
    const isRateLimit = data.code === 429 || /credit|rate limit/i.test(data.message || '');
    if (isRateLimit) {
      const err = new Error(`Rate limited fetching ${label} for ${symbol} — try again in a moment.`);
      err.isRateLimit = true;
      throw err;
    }
    throw new Error(data.message || `Twelve Data error for ${symbol} (${label})`);
  }

  if (!Array.isArray(data.values)) {
    throw new Error(`No ${label} data returned for ${symbol} — check the symbol is correct.`);
  }

  // Twelve Data returns newest-first; we want chronological ascending order.
  return data.values
    .map((v) => ({
      date: new Date(v.datetime),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: v.volume ? parseFloat(v.volume) : 0,
    }))
    .filter((c) => !Number.isNaN(c.close) && !Number.isNaN(c.high) && !Number.isNaN(c.low))
    .reverse();
}

// outputsize=300 four-hour bars comfortably covers 200+ bars for SMA200.
async function fetchFourHourCandles(symbol) {
  return fetchSeries(symbol, '4h', 300, '4H data');
}

// outputsize=2500 days (~10 years for established stocks) gives enough
// history to later derive ~500 weekly bars — plenty for a real SMA200 on
// the weekly timeframe too.
async function fetchDailyCandles(symbol) {
  return fetchSeries(symbol, '1day', 2500, 'daily data');
}

// Derives weekly candles from daily ones (Monday-start buckets) instead of
// spending a third API call — free tier credits are precious.
function aggregateToWeekly(dailyCandles) {
  const buckets = new Map();
  for (const c of dailyCandles) {
    const d = c.date;
    const day = d.getUTCDay(); // 0=Sun..6=Sat
    const diffToMonday = (day === 0 ? -6 : 1) - day;
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diffToMonday));
    const key = monday.getTime();
    if (!buckets.has(key)) {
      buckets.set(key, { date: monday, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
    } else {
      const b = buckets.get(key);
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close; // candles arrive chronologically, so this ends up being the week's last close
      b.volume += c.volume || 0;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.date - b.date);
}

// ---------- Indicator + scoring logic ----------

// A retracement level a fraction `r` of the way back from `from` toward `to`.
// Linear: straight subtraction. Log: interpolates in log-space then converts
// back — this matters most on large-percentage moves (e.g. a stock that went
// from $8 to $80), where a straight dollar-based retracement can land
// noticeably differently than where price has actually reacted historically.
function retraceLevel(from, to, ratio, useLog) {
  if (useLog && from > 0 && to > 0) {
    const logFrom = Math.log(from);
    const logTo = Math.log(to);
    return Math.exp(logFrom + (logTo - logFrom) * ratio);
  }
  return from + (to - from) * ratio;
}

function computeFibZone(candles, lookback, useLog = false) {
  const window = candles.slice(-lookback);
  if (window.length < 10) return null;

  let hh = -Infinity, hhIdx = 0, ll = Infinity, llIdx = 0;
  window.forEach((c, i) => {
    if (c.high > hh) { hh = c.high; hhIdx = i; }
    if (c.low < ll) { ll = c.low; llIdx = i; }
  });

  const range = hh - ll;
  if (range <= 0) return null;

  const uptrend = llIdx < hhIdx; // low happened first -> swing is low-to-high
  const from = uptrend ? hh : ll; // retracement always measured back from the swing's endpoint
  const to = uptrend ? ll : hh;

  // Golden zone widened to 0.618-0.786 — 0.786 is the level most technical
  // analysts treat as the practical limit of a valid pullback; beyond it,
  // the original trend is generally considered structurally broken rather
  // than just paused.
  const level618 = retraceLevel(from, to, 0.618, useLog);
  const level786 = retraceLevel(from, to, 0.786, useLog);
  const goldenLow = Math.min(level618, level786);
  const goldenHigh = Math.max(level618, level786);
  const direction = uptrend ? 'uptrend_pullback' : 'downtrend_bounce';

  const price = candles[candles.length - 1].close;
  const inZone = price >= goldenLow && price <= goldenHigh;
  const distancePct = inZone
    ? 0
    : (Math.min(Math.abs(price - goldenLow), Math.abs(price - goldenHigh)) / price) * 100;

  return {
    swingHigh: hh,
    swingLow: ll,
    direction,
    useLog,
    goldenLow,
    goldenHigh,
    inZone,
    approaching: !inZone && distancePct <= 3,
    distancePct: Number(distancePct.toFixed(2)),
    levels: {
      '0.0': from,
      '0.236': retraceLevel(from, to, 0.236, useLog),
      '0.382': retraceLevel(from, to, 0.382, useLog),
      '0.5': retraceLevel(from, to, 0.5, useLog),
      '0.618': level618,
      '0.786': level786,
      '1.0': to,
    },
    // Extensions always use log scale, even on timeframes where the
    // retracement itself is linear — this guarantees a positive result no
    // matter how large the percentage move was. Linear extensions can
    // subtract more dollars than the anchor price actually has for a stock
    // that's moved a huge percentage (e.g. a $10 -> $280 mover), producing
    // a nonsensical negative "price" at higher ratios like 2.618. Log scale
    // structurally cannot do that — deeper extension levels just approach
    // (never cross) zero, which is the correct real-world constraint.
    extensions: computeFibExtensions(hh, ll, direction, true),
  };
}

// Extensions project continuation targets beyond the swing — where price
// might go if the original trend resumes, rather than where a pullback
// might stall. A separate calculation from retracement, using ratios that
// extend past the 0-1 range of the swing itself.
function computeFibExtensions(hh, ll, direction, useLog) {
  const ratios = [1.272, 1.618, 2.272, 2.618];
  const levels = {};
  ratios.forEach((r) => {
    if (direction === 'uptrend_pullback') {
      // Projects upside targets above the prior high
      levels[r] = retraceLevel(ll, hh, r, useLog);
    } else {
      // Projects downside targets below the prior low
      levels[r] = retraceLevel(hh, ll, r, useLog);
    }
  });
  return levels;
}

// ---------- Multi-zone support/resistance ladder ----------
//
// A single golden zone only ever shows one side of the picture — this
// gathers every reference level already computed elsewhere (both
// Fibonacci golden zones, not just whichever direction the swing happened
// to run; extensions in both directions; Bollinger Bands; moving averages;
// recent swing pivots) and classifies each purely by where it sits
// relative to CURRENT price: below price = support ("buy zone"), above
// price = resistance ("sell zone"). Because the role is derived fresh from
// current price every time rather than baked into swing history, a level
// automatically "flips" from resistance to support (or back) the moment
// price crosses it — no special-case logic needed for that.
//
// Deliberately simple for now (Option 1, per user request): every
// candidate within the top few nearest each side is shown as-is, with no
// merging of levels that happen to sit very close together (that's the
// planned Option 2 for later, if this turns out to be too cluttered).
function buildLevelLadder(candles, price, bb, sma20, sma50, sma200, fibLookback, useLog) {
  const candidates = [];
  const add = (value, label) => {
    if (value == null || !Number.isFinite(value) || value <= 0) return;
    candidates.push({ price: value, label });
  };

  const window = candles.slice(-fibLookback);
  if (window.length >= 10) {
    let hh = -Infinity;
    let ll = Infinity;
    window.forEach((c) => {
      if (c.high > hh) hh = c.high;
      if (c.low < ll) ll = c.low;
    });

    if (hh > 0 && ll > 0 && hh > ll) {
      // Golden zone, BOTH directions — not just whichever one the
      // chronological swing order happened to produce.
      const pbLow = retraceLevel(hh, ll, 0.786, useLog);
      const pbHigh = retraceLevel(hh, ll, 0.618, useLog);
      add(Math.min(pbLow, pbHigh), 'Golden zone (pullback) low');
      add(Math.max(pbLow, pbHigh), 'Golden zone (pullback) high');

      const bnLow = retraceLevel(ll, hh, 0.618, useLog);
      const bnHigh = retraceLevel(ll, hh, 0.786, useLog);
      add(Math.min(bnLow, bnHigh), 'Golden zone (bounce) low');
      add(Math.max(bnLow, bnHigh), 'Golden zone (bounce) high');

      // Extensions, both directions — nearer two ratios only, to keep the
      // candidate pool reasonable (the full 4-ratio set is still used for
      // the single-direction fib.extensions field elsewhere).
      add(retraceLevel(ll, hh, 1.272, true), 'Extension 127.2% (upside)');
      add(retraceLevel(ll, hh, 1.618, true), 'Extension 161.8% (upside)');
      add(retraceLevel(hh, ll, 1.272, true), 'Extension 127.2% (downside)');
      add(retraceLevel(hh, ll, 1.618, true), 'Extension 161.8% (downside)');

      // Recent swing pivots — actual historical turning points, reusing
      // the same pivot detector built for RSI divergence, rather than only
      // the single overall swing high/low.
      const closesWindow = window.map((c) => c.close);
      const pivots = findPivots(closesWindow, 3);
      pivots.filter((p) => p.type === 'high').slice(-3).forEach((p) => add(p.value, 'Prior swing high'));
      pivots.filter((p) => p.type === 'low').slice(-3).forEach((p) => add(p.value, 'Prior swing low'));
    }
  }

  add(bb && bb.upper, 'Upper Bollinger Band');
  add(bb && bb.lower, 'Lower Bollinger Band');
  add(sma20, '20-period MA');
  add(sma50, '50-period MA');
  add(sma200, '200-period MA');

  const support = candidates
    .filter((c) => c.price < price)
    .sort((a, b) => b.price - a.price) // nearest below price first
    .slice(0, 4)
    .map((c) => ({ price: Number(c.price.toFixed(2)), label: c.label }));

  const resistance = candidates
    .filter((c) => c.price > price)
    .sort((a, b) => a.price - b.price) // nearest above price first
    .slice(0, 4)
    .map((c) => ({ price: Number(c.price.toFixed(2)), label: c.label }));

  return { support, resistance };
}

// ---------- RSI divergence & volume confirmation ----------

const RSI_PERIOD = 14;

// Finds local extrema (swing highs/lows) using a symmetric window — a point
// qualifies as a pivot only if it's the max/min among `span` bars on each
// side of it. This filters out noise while still catching real swings.
function findPivots(values, span = 3) {
  const pivots = [];
  for (let i = span; i < values.length - span; i++) {
    const windowSlice = values.slice(i - span, i + span + 1);
    const center = values[i];
    const maxInWindow = Math.max(...windowSlice);
    const minInWindow = Math.min(...windowSlice);
    if (center === maxInWindow) pivots.push({ index: i, value: center, type: 'high' });
    else if (center === minInWindow) pivots.push({ index: i, value: center, type: 'low' });
  }
  return pivots;
}

// Compares the two most recent comparable price pivots against RSI at those
// same points in time. Bearish divergence: price makes a higher high while
// RSI makes a lower high (momentum fading even as price pushes up). Bullish
// divergence: price makes a lower low while RSI makes a higher low (selling
// momentum fading even as price pushes down).
function detectDivergence(closes, rsiValues, lookback) {
  const startIdx = Math.max(0, closes.length - lookback);
  const priceSlice = closes.slice(startIdx);
  const pivots = findPivots(priceSlice, 3).map((p) => ({ ...p, index: p.index + startIdx }));

  const priceHighs = pivots.filter((p) => p.type === 'high');
  const priceLows = pivots.filter((p) => p.type === 'low');

  function rsiAt(priceIndex) {
    const rsiIndex = priceIndex - RSI_PERIOD;
    return rsiIndex >= 0 && rsiIndex < rsiValues.length ? rsiValues[rsiIndex] : null;
  }

  if (priceHighs.length >= 2) {
    const [h1, h2] = priceHighs.slice(-2);
    const rsi1 = rsiAt(h1.index);
    const rsi2 = rsiAt(h2.index);
    if (rsi1 != null && rsi2 != null && h2.value > h1.value && rsi2 < rsi1) {
      return { type: 'bearish', priceFrom: h1.value, priceTo: h2.value, rsiFrom: rsi1, rsiTo: rsi2 };
    }
  }

  if (priceLows.length >= 2) {
    const [l1, l2] = priceLows.slice(-2);
    const rsi1 = rsiAt(l1.index);
    const rsi2 = rsiAt(l2.index);
    if (rsi1 != null && rsi2 != null && l2.value < l1.value && rsi2 > rsi1) {
      return { type: 'bullish', priceFrom: l1.value, priceTo: l2.value, rsiFrom: rsi1, rsiTo: rsi2 };
    }
  }

  return null;
}

// Compares average volume over the most recent bars against the bars just
// before that, as a lightweight "is conviction fading or building" check —
// used to confirm (or not) whatever divergence signal is found.
function computeVolumeTrend(candles, recentN = 5, priorN = 5) {
  if (candles.length < recentN + priorN) return null;
  const vols = candles.map((c) => c.volume || 0);
  const recent = vols.slice(-recentN);
  const prior = vols.slice(-(recentN + priorN), -recentN);
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const priorAvg = prior.reduce((a, b) => a + b, 0) / prior.length;
  if (priorAvg === 0) return null;
  const changePct = ((recentAvg - priorAvg) / priorAvg) * 100;
  return { recentAvg, priorAvg, changePct: Number(changePct.toFixed(1)), direction: changePct >= 0 ? 'rising' : 'falling' };
}

// ---------- Cross-timeframe golden-zone context ----------
//
// A single timeframe's swing high/low can't tell apart two very different
// situations that look identical in isolation:
//   - uptrend_pullback zone = a correction within a BIGGER uptrend (genuine
//     support, bullish) vs. just a brief pause within a bigger downtrend
//     (support likely to fail).
//   - downtrend_bounce zone = a corrective rally within a BIGGER downtrend
//     (resistance, likely to fail and resume the decline) vs. a genuine
//     reclaim within a bigger uptrend (more credible as a real bottom).
// A higher timeframe's own trend (simple MA direction) resolves this
// ambiguity — when we have it. When we don't (insufficient data), we apply
// no discount at all, since we have no basis to doubt the read.
function fibZoneMultiplier(direction, higherTrendBullish) {
  if (higherTrendBullish == null) return 1.0;
  if (direction === 'uptrend_pullback') {
    return higherTrendBullish ? 1.0 : 0.4;
  }
  return higherTrendBullish ? 0.7 : 0.2; // downtrend_bounce
}

function fibZoneSignalType(multiplier) {
  if (multiplier >= 0.7) return 'bullish';
  if (multiplier >= 0.3) return 'watch';
  return 'caution';
}

function fibZoneContextNote(direction, higherTrendBullish) {
  if (higherTrendBullish == null) return '';
  if (direction === 'uptrend_pullback') {
    return higherTrendBullish
      ? ' — higher timeframe trend agrees'
      : ' — but higher timeframe trend disagrees, weaker case';
  }
  return higherTrendBullish
    ? ' — higher timeframe trend disagrees with the downtrend read, possible genuine reclaim'
    : ' — higher timeframe confirms the downtrend, bounce more likely to fail';
}

// ---------- Long-range "major zone" detection ----------
//
// The regular ladder (buildLevelLadder) and Fibonacci zone are both built
// from a short, recent window — good for near-term entry timing, but blind
// to zones that only become "major" because price has tested them
// repeatedly over a much longer history. This scans as much history as
// we've got for pivot highs/lows, clusters ones that land within a small
// percentage of each other, and ranks by how many times that price area
// was actually retested — closer to how a trader would eyeball "this has
// acted as support four separate times" rather than just "this is close."
function buildMajorLevels(candles, price) {
  const closes = candles.map((c) => c.close);
  const pivots = findPivots(closes, 3);
  if (pivots.length < 2) return { support: [], resistance: [] };

  const CLUSTER_TOLERANCE_PCT = 0.02; // pivots within 2% of each other count as the same zone

  // A level only counts as separately "tested" if price genuinely departed
  // the zone and came back — not just because another pivot was detected
  // some bars later. A single extended sideways consolidation can produce
  // many pivots a few bars apart without price ever truly leaving the
  // area, which would otherwise inflate one continuous period into a
  // dozen+ fake "touches." Requiring a real round trip (price moving at
  // least a few multiples of the cluster tolerance away, then returning)
  // collapses that into the one visit it actually was, while still
  // correctly counting genuinely separate revisits weeks or months apart.
  const DEPARTURE_MULTIPLIER = 2.5;

  const sorted = [...pivots].sort((a, b) => a.value - b.value);
  const clusters = [];

  sorted.forEach((p) => {
    const existing = clusters.find((c) => Math.abs(p.value - c.avgPrice) / c.avgPrice <= CLUSTER_TOLERANCE_PCT);
    if (existing) {
      const departureThreshold = existing.avgPrice * CLUSTER_TOLERANCE_PCT * DEPARTURE_MULTIPLIER;
      const lastTouchIndex = Math.max(...existing.touches.map((t) => t.index));
      const start = Math.min(lastTouchIndex, p.index);
      const end = Math.max(lastTouchIndex, p.index) + 1;
      const departed = closes.slice(start, end).some((c) => Math.abs(c - existing.avgPrice) >= departureThreshold);
      if (!departed) return; // price never really left this zone since the last count — same visit, skip

      existing.touches.push(p);
      existing.avgPrice = existing.touches.reduce((s, t) => s + t.value, 0) / existing.touches.length;
    } else {
      clusters.push({ avgPrice: p.value, touches: [p] });
    }
  });

  // Only clusters genuinely retested (2+ touches) count as "major" — a
  // single pivot is just a swing point, not a proven zone. On top of that,
  // the touches need to span a meaningful chunk of the total window — a
  // level tested 8 times within one tight 60-day consolidation isn't the
  // same thing as one that's held up across 18 months, even though the
  // departure check above confirms both are "genuine" touches. Without
  // this, a short early choppy period can outrank a level that's actually
  // proven itself over a much longer, more relevant stretch of time.
  const minSpanBars = Math.round(closes.length * 0.15);

  const significant = clusters
    .filter((c) => c.touches.length >= 2)
    .filter((c) => {
      const indices = c.touches.map((t) => t.index);
      return Math.max(...indices) - Math.min(...indices) >= minSpanBars;
    })
    .map((c) => ({
      price: Number(c.avgPrice.toFixed(2)),
      touchCount: c.touches.length,
      label: `Major level (${c.touches.length} touches)`,
    }));

  const rankAndPick = (list) =>
    list
      .sort((a, b) => b.touchCount - a.touchCount || Math.abs(a.price - price) - Math.abs(b.price - price))
      .slice(0, 3);

  return {
    support: rankAndPick(significant.filter((l) => l.price < price)),
    resistance: rankAndPick(significant.filter((l) => l.price > price)),
  };
}

function analyzeTimeframe(candles, fibLookback, useLog = false, higherTrendBullish = null, longRangeLookback = null) {
  const closes = candles.map((c) => c.close);
  if (closes.length < 30) {
    return { insufficientData: true };
  }

  const rsiValues = RSI.calculate({ values: closes, period: RSI_PERIOD });
  const bbValues = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
  const sma20Values = SMA.calculate({ values: closes, period: 20 });
  const sma50Values = SMA.calculate({ values: closes, period: Math.min(50, Math.floor(closes.length / 2)) });
  const hasEnoughFor200 = closes.length >= 210;
  const sma200Values = hasEnoughFor200 ? SMA.calculate({ values: closes, period: 200 }) : [];

  const price = closes[closes.length - 1];
  const rsi = rsiValues[rsiValues.length - 1];
  const bb = bbValues[bbValues.length - 1];
  const sma20 = sma20Values[sma20Values.length - 1];
  const sma50 = sma50Values[sma50Values.length - 1];
  const sma200 = sma200Values.length ? sma200Values[sma200Values.length - 1] : null;
  const fib = computeFibZone(candles, fibLookback, useLog);
  const divergence = rsiValues.length >= 20 ? detectDivergence(closes, rsiValues, fibLookback) : null;
  const volumeTrend = computeVolumeTrend(candles);
  const levels = buildLevelLadder(candles, price, bb, sma20, sma50, sma200, fibLookback, useLog);

  // Long-range structure: a separate pass over much more history than the
  // short-window fib/ladder above, aimed at surfacing genuinely major zones
  // (tested repeatedly over months/years) rather than just the most recent
  // swing. Only computed when a longer lookback is actually available and
  // requested — 4H doesn't have enough history fetched for this to be
  // meaningful, so it's skipped there (longRangeLookback stays null).
  const longRangeFib = longRangeLookback ? computeFibZone(candles, longRangeLookback, useLog) : null;
  const majorLevels = longRangeLookback ? buildMajorLevels(candles, price) : null;

  // ---- Component scoring (each contributes to a 0-100 opportunity score) ----
  let score = 50; // neutral baseline
  const signals = [];

  if (rsi != null) {
    if (rsi < 30) { score += 20; signals.push({ type: 'bullish', label: `RSI oversold (${rsi.toFixed(1)})` }); }
    else if (rsi < 45) { score += 8; signals.push({ type: 'bullish', label: `RSI recovering (${rsi.toFixed(1)})` }); }
    else if (rsi > 70) { score -= 25; signals.push({ type: 'caution', label: `RSI overbought (${rsi.toFixed(1)})` }); }
    else if (rsi > 60) { score -= 5; signals.push({ type: 'watch', label: `RSI warming up (${rsi.toFixed(1)})` }); }
  }

  if (bb != null) {
    const pctB = (price - bb.lower) / (bb.upper - bb.lower);
    if (pctB <= 0.1) { score += 15; signals.push({ type: 'bullish', label: 'Price at/below lower Bollinger Band' }); }
    else if (pctB <= 0.3) { score += 6; signals.push({ type: 'bullish', label: 'Price in lower Bollinger Band range' }); }
    else if (pctB >= 0.95) { score -= 20; signals.push({ type: 'caution', label: 'Price at/above upper Bollinger Band' }); }
    else if (pctB >= 0.8) { score -= 5; signals.push({ type: 'watch', label: 'Price nearing upper Bollinger Band' }); }
  }

  if (fib) {
    const zoneMult = fibZoneMultiplier(fib.direction, higherTrendBullish);
    const contextNote = fibZoneContextNote(fib.direction, higherTrendBullish);
    const zoneTypeLabel = fib.direction === 'uptrend_pullback' ? 'pullback' : 'bounce';

    if (fib.inZone) {
      const bonus = Math.round(25 * zoneMult);
      score += bonus;
      signals.push({
        type: fibZoneSignalType(zoneMult),
        label: `In Fibonacci golden zone (${zoneTypeLabel})${contextNote}`,
      });
    } else if (fib.approaching) {
      const bonus = Math.round(10 * zoneMult);
      score += bonus;
      signals.push({
        type: fibZoneSignalType(zoneMult),
        label: `Approaching golden zone (${fib.distancePct}% away)${contextNote}`,
      });
    }
  }

  if (sma20 != null && sma50 != null) {
    const uptrendContext = sma20 > sma50;
    if (uptrendContext && price < sma20 && price > sma50) {
      score += 8; signals.push({ type: 'bullish', label: 'Healthy pullback toward rising MAs' });
    } else if (!uptrendContext && price > sma20) {
      score -= 5; signals.push({ type: 'watch', label: 'Price extended above MAs in a downtrend' });
    }
    signals.push({ type: 'info', label: uptrendContext ? 'MA trend: bullish (20 > 50)' : 'MA trend: bearish (20 < 50)' });
  }

  if (sma200 != null) {
    if (price > sma200) {
      score += 5; signals.push({ type: 'info', label: 'Above 200-day MA (long-term uptrend)' });
    } else {
      score -= 5; signals.push({ type: 'watch', label: 'Below 200-day MA (long-term downtrend)' });
    }
  }

  if (volumeTrend) {
    signals.push({ type: 'info', label: `Volume trend: ${volumeTrend.direction} (${volumeTrend.changePct >= 0 ? '+' : ''}${volumeTrend.changePct}%)` });
  }

  if (divergence) {
    const volumeConfirms = volumeTrend && volumeTrend.direction === 'falling';
    if (divergence.type === 'bearish') {
      const penalty = volumeConfirms ? 20 : 15;
      score -= penalty;
      signals.push({
        type: 'caution',
        label: `Bearish RSI divergence (price higher high, RSI lower high)${volumeConfirms ? ' + fading volume on the rally' : ''}`,
      });
    } else if (divergence.type === 'bullish') {
      const bonus = volumeConfirms ? 20 : 15;
      score += bonus;
      signals.push({
        type: 'bullish',
        label: `Bullish RSI divergence (price lower low, RSI higher low)${volumeConfirms ? ' + fading volume on the decline' : ''}`,
      });
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let label = 'Neutral';
  if (score >= 75) label = 'Golden Opportunity';
  else if (score >= 60) label = 'Building Setup';
  else if (score <= 25) label = 'Overbought / Caution';
  else if (score <= 40) label = 'Weak / Wait';

  return {
    price: Number(price.toFixed(2)),
    rsi: rsi != null ? Number(rsi.toFixed(1)) : null,
    bollinger: bb ? { upper: Number(bb.upper.toFixed(2)), middle: Number(bb.middle.toFixed(2)), lower: Number(bb.lower.toFixed(2)) } : null,
    sma20: sma20 != null ? Number(sma20.toFixed(2)) : null,
    sma50: sma50 != null ? Number(sma50.toFixed(2)) : null,
    sma200: sma200 != null ? Number(sma200.toFixed(2)) : null,
    fib,
    divergence,
    volumeTrend,
    levels,
    longRangeFib,
    majorLevels,
    score,
    label,
    signals,
    candles: candles.slice(-120).map((c) => ({ date: c.date, close: Number(c.close.toFixed(2)) })),
  };
}

// ---------- Plain-English guidance ----------

function fmt(n) {
  return n != null ? `$${Number(n).toFixed(2)}` : null;
}

function buildGuidance(tf4h, tf1d, tf1w) {
  const candidates = [
    { key: '4H', tf: tf4h },
    { key: 'Daily', tf: tf1d },
    { key: 'Weekly', tf: tf1w },
  ].filter((c) => c.tf && !c.tf.insufficientData);

  if (!candidates.length) {
    return 'Not enough history yet to generate guidance for this stock.';
  }

  // Lead with whichever timeframe's own score is most decisive (furthest
  // from the neutral baseline of 50) — a strong 4H signal shouldn't get
  // buried under a quiet daily reading just because daily happens to be
  // the default. The overall blended score can be driven by any timeframe.
  const lead = candidates.reduce((best, c) =>
    Math.abs(c.tf.score - 50) > Math.abs(best.tf.score - 50) ? c : best
  );

  const { rsi, fib, sma20, bollinger, score, label } = lead.tf;

  const invalidation = fib ? fmt(fib.swingLow) : null;
  const invalidationNote = invalidation
    ? ` A close below ${invalidation} would invalidate this setup.`
    : '';

  // Extension targets answer the other half of "where might this go" —
  // retracement/golden-zone tells you where a pullback might stall;
  // extensions project where price might head if the move continues past
  // the swing instead, in the opposite direction from the invalidation level.
  const extensionNote = fib && fib.extensions && fib.extensions['1.272'] != null && fib.extensions['1.618'] != null
    ? ` If the move continues past the recent ${fib.direction === 'uptrend_pullback' ? 'high' : 'low'} instead, reference targets sit near ${fmt(fib.extensions['1.272'])} and ${fmt(fib.extensions['1.618'])}.`
    : '';

  const { divergence, volumeTrend } = lead.tf;
  const volumeConfirmsDivergence = divergence && volumeTrend && volumeTrend.direction === 'falling';
  const divergenceNote = divergence
    ? divergence.type === 'bearish'
      ? ` Also worth flagging: RSI is showing bearish divergence — price made a higher high while RSI made a lower high, often an early sign that upward momentum is fading before price itself turns.${volumeConfirmsDivergence ? ' Volume has been declining on this rally too, adding to the case that conviction is weakening.' : ''}`
      : ` Also worth flagging: RSI is showing bullish divergence — price made a lower low while RSI made a higher low, often an early sign that selling pressure is fading before price itself turns.${volumeConfirmsDivergence ? ' Volume has been declining on this decline too, consistent with sellers losing conviction.' : ''}`
    : '';

  let core;

  if (fib && fib.inZone) {
    const zoneType = fib.direction === 'uptrend_pullback' ? 'pullback support' : 'bounce';
    core = `Price is trading inside the golden zone (${fmt(fib.goldenLow)}\u2013${fmt(fib.goldenHigh)}) right now — a ${zoneType} area, with RSI at ${rsi ?? '—'}. Zones like this don't always hold; watch for real confirmation (a reversal candle, a pickup in volume) rather than treating the zone itself as a green light.`;
  } else if (fib && fib.approaching) {
    if (fib.direction === 'uptrend_pullback') {
      core = `Price is currently ${fib.distancePct}% above the golden zone (${fmt(fib.goldenLow)}\u2013${fmt(fib.goldenHigh)}) — don't chase it up here. But don't assume a clean pullback into that zone is likely either: price often gets rejected well before reaching this deep, or breaks straight through it if the uptrend is actually rolling over rather than just pausing. Treat this level as somewhere to watch for a real reaction — a reversal candle, support holding on volume — not a target to buy on arrival.`;
    } else {
      core = `Price is currently ${fib.distancePct}% below the golden zone (${fmt(fib.goldenLow)}\u2013${fmt(fib.goldenHigh)}). Bounces off support around here tend to be somewhat more reliable than uptrend pullbacks reaching this deep, but it's still not guaranteed — watch for confirmation (a stall or reversal candle) rather than assuming an automatic bounce.`;
    }
  } else if (rsi != null && rsi >= 70) {
    core = `RSI is overbought at ${rsi} and price is stretched versus its recent range${bollinger ? ` (above ${fmt(bollinger.upper)})` : ''}. This isn't an attractive entry as-is — waiting for a pullback toward ${fmt(sma20)} or the golden zone would offer better risk/reward.`;
  } else if (rsi != null && rsi < 30) {
    core = `RSI is oversold at ${rsi}, suggesting the recent decline may be stretched. There's no clear golden zone nearby to confirm a bounce level here, so watch for a stabilization signal — RSI turning back up, a reversal candle — rather than assuming the drop is already done.`;
  } else if (score <= 40) {
    core = `Momentum is weak with no clear reversal signal yet. Wait for either RSI to turn up from an oversold level, or a confirmed bounce, before considering an entry.`;
  } else {
    core = `No strong setup right now on this timeframe — RSI is neutral at ${rsi ?? '—'}.${fib ? ` Worth checking back if price approaches the golden zone (${fmt(fib.goldenLow)}\u2013${fmt(fib.goldenHigh)}).` : ''}`;
  }

  // Say which timeframe is being described whenever it isn't the obvious
  // default (daily) — otherwise a strong 4H or weekly signal can silently
  // narrate as if it were about daily, which is exactly what caused
  // confusion before.
  const prefix = `${lead.key} (${label}): `;

  // Flag whether the other timeframes agree or disagree, rather than
  // silently presenting one timeframe's story as if it were the whole
  // picture — a blended score can land on "Golden Opportunity" even when
  // only one timeframe is genuinely strong and the others are lukewarm.
  const others = candidates.filter((c) => c.key !== lead.key);
  let synthesisNote = '';
  if (others.length) {
    const disagreeing = others.filter((c) => Math.abs(c.tf.score - score) >= 20);
    if (disagreeing.length) {
      const parts = disagreeing.map((c) => `${c.key} looks ${c.tf.label.toLowerCase()}`);
      synthesisNote = ` Worth noting: ${parts.join(', ')} — these timeframes aren't fully confirming each other yet, so treat this as a ${lead.key}-driven setup rather than one aligned across the board.`;
    } else {
      synthesisNote = ` This is broadly consistent with the ${others.map((c) => c.key).join(' and ')} timeframe${others.length > 1 ? 's' : ''} too, adding some confidence.`;
    }
  }

  return `${prefix}${core}${invalidationNote}${extensionNote}${divergenceNote}${synthesisNote}`;
}

async function analyzeSymbol(symbol) {
  // Only 2 API calls per symbol now — weekly is derived locally from daily
  // candles rather than spending a third credit on the free tier.
  const [fourHour, daily] = await Promise.all([
    fetchFourHourCandles(symbol),
    fetchDailyCandles(symbol),
  ]);

  const weekly = aggregateToWeekly(daily);

  // Weekly is computed first since it has no higher timeframe to check
  // against — its own golden-zone reads use no cross-timeframe discount.
  // Its simple MA trend direction (20 vs 50) then gets passed down to 4H
  // and daily, so a bounce/pullback zone on those timeframes can be scored
  // in light of the bigger picture rather than in isolation.
  // Long-range lookback: as much history as we reasonably have, capped so
  // we're not reaching back into potentially-irrelevant old price regimes
  // (~5 years of weekly, ~3 years of daily).
  const tf1w = analyzeTimeframe(weekly, 60, true, null, Math.min(weekly.length, 260));
  const weeklyTrendBullish = !tf1w.insufficientData && tf1w.sma20 != null && tf1w.sma50 != null
    ? tf1w.sma20 > tf1w.sma50
    : null;

  // Log-scale retracements for daily/weekly, where large percentage moves
  // are common and log scale tends to track historical reactions better.
  // 4H stays linear — short-term moves rarely differ much between the two.
  // 4H has no long-range pass — only ~200 days are fetched for it, not
  // enough history for "major" zones to mean anything.
  const tf4h = analyzeTimeframe(fourHour, 60, false, weeklyTrendBullish);
  const tf1d = analyzeTimeframe(daily, 90, true, weeklyTrendBullish, Math.min(daily.length, 750));

  // Weighted overall score: weekly = trend context, daily = intermediate, 4h = entry timing
  const weights = { w: 0.4, d: 0.35, h: 0.25 };
  const parts = [];
  if (!tf1w.insufficientData) parts.push([tf1w.score, weights.w]);
  if (!tf1d.insufficientData) parts.push([tf1d.score, weights.d]);
  if (!tf4h.insufficientData) parts.push([tf4h.score, weights.h]);

  let overallScore = null;
  let overallLabel = 'Insufficient data';
  if (parts.length) {
    const totalWeight = parts.reduce((s, [, w]) => s + w, 0);
    overallScore = Math.round(parts.reduce((s, [v, w]) => s + v * w, 0) / totalWeight);
    if (overallScore >= 75) overallLabel = 'Golden Opportunity';
    else if (overallScore >= 60) overallLabel = 'Building Setup';
    else if (overallScore <= 25) overallLabel = 'Overbought / Caution';
    else if (overallScore <= 40) overallLabel = 'Weak / Wait';
    else overallLabel = 'Neutral';
  }

  return {
    symbol,
    updatedAt: new Date().toISOString(),
    overallScore,
    overallLabel,
    guidance: buildGuidance(tf4h, tf1d, tf1w),
    timeframes: { '4h': tf4h, '1d': tf1d, '1w': tf1w },
  };
}

module.exports = { analyzeSymbol };
