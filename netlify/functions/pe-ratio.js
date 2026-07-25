const YahooFinance = require('yahoo-finance2').default;
const { getStore, connectLambda } = require('@netlify/blobs');

const yahooFinance = new YahooFinance();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function store() {
  return getStore('stock-scanner-pe-cache');
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Yahoo Finance request timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchPE(symbol) {
  const q = await withTimeout(yahooFinance.quote(symbol), 8000);
  if (!q) {
    throw new Error(`No quote data returned for ${symbol}`);
  }
  return {
    symbol,
    trailingPE: q.trailingPE ?? null,
    forwardPE: q.forwardPE ?? null,
    priceToBook: q.priceToBook ?? null,
    epsTrailingTwelveMonths: q.epsTrailingTwelveMonths ?? null,
    marketCap: q.marketCap ?? null,
  };
}

exports.handler = async (event) => {
  connectLambda(event);

  const symbol = (event.queryStringParameters && event.queryStringParameters.symbol || '').trim().toUpperCase();
  if (!symbol) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing symbol query parameter' }) };
  }

  try {
    const s = store();
    const cacheKey = `pe:${symbol}`;
    const cached = await s.get(cacheKey, { type: 'json' });
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cached.data, cached: true }) };
    }

    const result = await fetchPE(symbol);
    await s.setJSON(cacheKey, { data: result, fetchedAt: Date.now() });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...result, cached: false }) };
  } catch (err) {
    // Deliberately isolated: this endpoint failing (e.g. Yahoo's known crumb/
    // auth flakiness) never touches scan.js or the Twelve Data-based scanner.
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: `Could not fetch P/E for ${symbol} — Yahoo Finance can be unreliable; try again shortly.`,
        detail: String(err.message || err),
      }),
    };
  }
};
