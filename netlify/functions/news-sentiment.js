const { getStore, connectLambda } = require('@netlify/blobs');

const PULSE_BASE = 'https://pulsestocks123.netlify.app/api/news';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes — Pulse itself refreshes roughly hourly

function store() {
  return getStore('stock-scanner-news-sentiment-cache');
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Pulse request timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchSentiment(symbol) {
  const url = `${PULSE_BASE}?symbols=${encodeURIComponent(symbol)}`;
  const res = await withTimeout(fetch(url), 8000);
  const data = await res.json();

  if (!Array.isArray(data.articles)) {
    throw new Error(`Unexpected response from Pulse for ${symbol}`);
  }

  const counts = { bullish: 0, bearish: 0, neutral: 0 };
  let notable = null;

  data.articles.forEach((article) => {
    const s = article.sentiment || {};
    const label = (s.label || 'Neutral').toLowerCase();
    if (label.includes('bullish')) counts.bullish += 1;
    else if (label.includes('bearish')) counts.bearish += 1;
    else counts.neutral += 1;

    // Most notable = highest-magnitude non-neutral score, most recent as tiebreaker.
    if (Math.abs(s.score || 0) >= 2) {
      if (
        !notable ||
        Math.abs(s.score) > Math.abs(notable.sentiment.score) ||
        (Math.abs(s.score) === Math.abs(notable.sentiment.score) &&
          new Date(article.publishedAt || 0) > new Date(notable.publishedAt || 0))
      ) {
        notable = article;
      }
    }
  });

  return {
    symbol,
    totalArticles: data.articles.length,
    counts,
    notable: notable
      ? {
          title: notable.title,
          publisher: notable.publisher,
          link: notable.link,
          publishedAt: notable.publishedAt,
          sentiment: notable.sentiment,
        }
      : null,
    pulseErrors: Array.isArray(data.errors) ? data.errors.length : 0,
  };
}

module.exports.fetchSentiment = fetchSentiment;
exports.handler = async (event) => {
  connectLambda(event);

  const symbol = (event.queryStringParameters && event.queryStringParameters.symbol || '').trim().toUpperCase();
  if (!symbol) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing symbol query parameter' }) };
  }

  try {
    const s = store();
    const cacheKey = `news-sentiment:${symbol}`;
    const cached = await s.get(cacheKey, { type: 'json' });
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cached.data, cached: true }) };
    }

    const result = await fetchSentiment(symbol);
    await s.setJSON(cacheKey, { data: result, fetchedAt: Date.now() });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...result, cached: false }) };
  } catch (err) {
    // Isolated from the core scanner on purpose — Pulse (and the Yahoo
    // data it depends on) being unavailable should only ever break this
    // one button, never the Twelve Data-based technical analysis.
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: `Could not fetch news sentiment for ${symbol} — Pulse (or the Yahoo data it relies on) can be unreliable; try again shortly.`,
        detail: String(err.message || err),
      }),
    };
  }
};
