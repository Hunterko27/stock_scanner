const { getStore, connectLambda } = require('@netlify/blobs');

const API_KEY = process.env.TWELVE_DATA_API_KEY;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — earnings dates rarely change

function store() {
  return getStore('stock-scanner-earnings-cache');
}

async function fetchEarnings(symbol) {
  const url = `https://api.twelvedata.com/earnings?symbol=${encodeURIComponent(symbol)}&apikey=${API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.status === 'error' || data.code >= 400) {
    throw new Error(data.message || `Twelve Data error fetching earnings for ${symbol}`);
  }

  // The exact response shape for this endpoint isn't confirmed against a
  // live key from this environment, so we parse defensively and fail with a
  // clear message rather than silently returning something wrong.
  const list = data.earnings || data.data || (Array.isArray(data) ? data : null);
  if (!Array.isArray(list)) {
    throw new Error(`Unexpected response shape from earnings endpoint for ${symbol} — keys received: ${Object.keys(data).join(', ')}`);
  }

  const withDates = list
    .map((item) => ({ ...item, _date: new Date(item.date || item.report_date || item.datetime) }))
    .filter((item) => !Number.isNaN(item._date.getTime()))
    .sort((a, b) => a._date - b._date);

  const now = new Date();
  const upcoming = withDates.find((item) => item._date >= now);
  const mostRecentPast = [...withDates].reverse().find((item) => item._date < now);

  const chosen = upcoming || mostRecentPast;
  if (!chosen) {
    return { symbol, nextEarningsDate: null, daysUntil: null, isPast: null };
  }

  const daysUntil = Math.round((chosen._date - now) / (24 * 60 * 60 * 1000));
  return {
    symbol,
    nextEarningsDate: chosen._date.toISOString().slice(0, 10),
    daysUntil,
    isPast: !upcoming,
  };
}

exports.handler = async (event) => {
  connectLambda(event);

  const symbol = (event.queryStringParameters && event.queryStringParameters.symbol || '').trim().toUpperCase();
  if (!symbol) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing symbol query parameter' }) };
  }
  if (!API_KEY) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Server is missing TWELVE_DATA_API_KEY' }) };
  }

  try {
    const s = store();
    const cacheKey = `earnings:${symbol}`;
    const cached = await s.get(cacheKey, { type: 'json' });
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cached.data, cached: true }) };
    }

    const result = await fetchEarnings(symbol);
    await s.setJSON(cacheKey, { data: result, fetchedAt: Date.now() });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...result, cached: false }) };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Could not fetch earnings for ${symbol}`, detail: String(err.message || err) }),
    };
  }
};
