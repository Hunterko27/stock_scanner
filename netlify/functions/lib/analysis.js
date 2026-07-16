const YahooFinance = require('yahoo-finance2').default;
const { RSI, BollingerBands, SMA } = require('technicalindicators');

const yahooFinance = new YahooFinance({ queue: { concurrency: 4, interval: 250 } });

// ---------- Data fetching ----------

// Yahoo has no native 4h interval, so we pull hourly candles and
// aggregate every 4 hours ourselves.
async function fetchHourlyCandles(symbol, days = 180) {
  const period2 = new Date();
  const period1 = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await yahooFinance.chart(symbol, {
    period1,
    period2,
    interval: '60m',
  });
  return (result.quotes || []).filter(
    (q) => q.close != null && q.high != null && q.low != null
  );
}

async function fetchDailyCandles(symbol, days = 500) {
  const period2 = new Date();
  const period1 = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await yahooFinance.chart(symbol, {
    period1,
    period2,
    interval: '1d',
  });
  return (result.quotes || []).filter(
    (q) => q.close != null && q.high != null && q.low != null
  );
}

async function fetchWeeklyCandles(symbol, days = 1460) {
  const period2 = new Date();
  const period1 = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await yahooFinance.chart(symbol, {
    period1,
    period2,
    interval: '1wk',
  });
  return (result.quotes || []).filter(
    (q) => q.close != null && q.high != null && q.low != null
  );
}

function aggregateTo4h(hourlyCandles) {
  const buckets = new Map();
  for (const c of hourlyCandles) {
    const t = new Date(c.date).getTime();
    const bucketStart = Math.floor(t / (4 * 60 * 60 * 1000)) * (4 * 60 * 60 * 1000);
    if (!buckets.has(bucketStart)) {
      buckets.set(bucketStart, {
        date: new Date(bucketStart),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 0,
      });
    } else {
      const b = buckets.get(bucketStart);
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
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

  const price = closes[closes.length - 1];
  const rsi = rsiValues[rsiValues.length - 1];
  const bb = bbValues[bbValues.length - 1];
  const sma20 = sma20Values[sma20Values.length - 1];
  const sma50 = sma50Values[sma50Values.length - 1];
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
    fib,
    score,
    label,
    signals,
    candles: candles.slice(-120).map((c) => ({ date: c.date, close: Number(c.close.toFixed(2)) })),
  };
}

async function analyzeSymbol(symbol) {
  const [hourly, daily, weekly] = await Promise.all([
    fetchHourlyCandles(symbol, 180),
    fetchDailyCandles(symbol, 500),
    fetchWeeklyCandles(symbol, 1460),
  ]);

  const fourHour = aggregateTo4h(hourly);

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
    timeframes: { '4h': tf4h, '1d': tf1d, '1w': tf1w },
  };
}

module.exports = { analyzeSymbol };
