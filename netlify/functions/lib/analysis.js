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

function computeFibZone(candles, lookback) {
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
  let goldenLow, goldenHigh, direction;

  if (uptrend) {
    // Retracement measured down from the high; golden pocket 0.618-0.65 of the move
    goldenLow = hh - range * 0.65;
    goldenHigh = hh - range * 0.618;
    direction = 'uptrend_pullback';
  } else {
    // Swing is high-to-low; golden pocket is the bounce zone off the low
    goldenLow = ll + range * 0.618;
    goldenHigh = ll + range * 0.65;
    direction = 'downtrend_bounce';
  }

  const price = candles[candles.length - 1].close;
  const inZone = price >= goldenLow && price <= goldenHigh;
  const distancePct = inZone
    ? 0
    : (Math.min(Math.abs(price - goldenLow), Math.abs(price - goldenHigh)) / price) * 100;

  return {
    swingHigh: hh,
    swingLow: ll,
    direction,
    goldenLow,
    goldenHigh,
    inZone,
    approaching: !inZone && distancePct <= 3,
    distancePct: Number(distancePct.toFixed(2)),
    levels: {
      '0.0': uptrend ? hh : ll,
      '0.236': uptrend ? hh - range * 0.236 : ll + range * 0.236,
      '0.382': uptrend ? hh - range * 0.382 : ll + range * 0.382,
      '0.5': uptrend ? hh - range * 0.5 : ll + range * 0.5,
      '0.618': uptrend ? hh - range * 0.618 : ll + range * 0.618,
      '0.65': uptrend ? hh - range * 0.65 : ll + range * 0.65,
      '0.786': uptrend ? hh - range * 0.786 : ll + range * 0.786,
      '1.0': uptrend ? ll : hh,
    },
  };
}

function analyzeTimeframe(candles, fibLookback) {
  const closes = candles.map((c) => c.close);
  if (closes.length < 30) {
    return { insufficientData: true };
  }

  const rsiValues = RSI.calculate({ values: closes, period: 14 });
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
  const fib = computeFibZone(candles, fibLookback);

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
    if (fib.inZone) { score += 25; signals.push({ type: 'bullish', label: `In Fibonacci golden zone (${fib.direction === 'uptrend_pullback' ? 'pullback' : 'bounce'})` }); }
    else if (fib.approaching) { score += 10; signals.push({ type: 'watch', label: `Approaching golden zone (${fib.distancePct}% away)` }); }
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

function buildGuidance(tf1d, tf1w, overallScore) {
  if (!tf1d || tf1d.insufficientData) {
    return 'Not enough daily history yet to generate guidance for this stock.';
  }

  const { rsi, price, fib, sma20, bollinger } = tf1d;
  const weeklyTrendNote = tf1w && !tf1w.insufficientData && tf1w.sma20 != null && tf1w.sma50 != null
    ? ` On the weekly timeframe, the broader trend is ${tf1w.sma20 > tf1w.sma50 ? 'bullish' : 'bearish'} (20 ${tf1w.sma20 > tf1w.sma50 ? '>' : '<'} 50 MA).`
    : '';

  // Invalidation level: the swing low underpinning the current setup. If
  // price closes below it, the structure the setup relies on has broken.
  const invalidation = fib ? fmt(fib.swingLow) : null;
  const invalidationNote = invalidation
    ? ` A close below ${invalidation} would invalidate this setup.`
    : '';

  if (fib && fib.inZone) {
    const zoneType = fib.direction === 'uptrend_pullback' ? 'pullback support' : 'bounce';
    return `Price is trading inside the golden zone (${fmt(fib.goldenLow)}\u2013${fmt(fib.goldenHigh)}) right now — a ${zoneType} area, with RSI at ${rsi ?? '—'}. Zones like this don't always hold; watch for real confirmation (a reversal candle, a pickup in volume) rather than treating the zone itself as a green light.${invalidationNote}${weeklyTrendNote}`;
  }

  if (fib && fib.approaching) {
    if (fib.direction === 'uptrend_pullback') {
      return `Price is currently ${fib.distancePct}% above the golden zone (${fmt(fib.goldenLow)}\u2013${fmt(fib.goldenHigh)}) — don't chase it up here. But don't assume a clean pullback into that zone is likely either: price often gets rejected well before reaching this deep, or breaks straight through it if the uptrend is actually rolling over rather than just pausing. Treat this level as somewhere to watch for a real reaction — a reversal candle, support holding on volume — not a target to buy on arrival.${invalidationNote}${weeklyTrendNote}`;
    }
    return `Price is currently ${fib.distancePct}% below the golden zone (${fmt(fib.goldenLow)}\u2013${fmt(fib.goldenHigh)}). Bounces off support around here tend to be somewhat more reliable than uptrend pullbacks reaching this deep, but it's still not guaranteed — watch for confirmation (a stall or reversal candle) rather than assuming an automatic bounce.${invalidationNote}${weeklyTrendNote}`;
  }

  if (rsi != null && rsi >= 70) {
    return `RSI is overbought at ${rsi} and price is stretched versus its recent range${bollinger ? ` (above ${fmt(bollinger.upper)})` : ''}. This isn't an attractive entry as-is — waiting for a pullback toward ${fmt(sma20)} or the golden zone would offer better risk/reward.${weeklyTrendNote}`;
  }

  if (overallScore != null && overallScore <= 40) {
    return `Momentum is weak with no clear reversal signal yet.${invalidationNote ? ' Wait for either RSI to turn up from an oversold level, or a confirmed bounce, before considering an entry.' : ' Wait for a clearer signal before considering an entry.'}${weeklyTrendNote}`;
  }

  return `No strong setup right now — RSI is neutral at ${rsi ?? '—'}.${fib ? ` Worth checking back if price approaches the golden zone (${fmt(fib.goldenLow)}\u2013${fmt(fib.goldenHigh)}).` : ''}${weeklyTrendNote}`;
}

async function analyzeSymbol(symbol) {
  // Only 2 API calls per symbol now — weekly is derived locally from daily
  // candles rather than spending a third credit on the free tier.
  const [fourHour, daily] = await Promise.all([
    fetchFourHourCandles(symbol),
    fetchDailyCandles(symbol),
  ]);

  const weekly = aggregateToWeekly(daily);

  const tf4h = analyzeTimeframe(fourHour, 60);
  const tf1d = analyzeTimeframe(daily, 90);
  const tf1w = analyzeTimeframe(weekly, 60);

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
    guidance: buildGuidance(tf1d, tf1w, overallScore),
    timeframes: { '4h': tf4h, '1d': tf1d, '1w': tf1w },
  };
}

module.exports = { analyzeSymbol };
