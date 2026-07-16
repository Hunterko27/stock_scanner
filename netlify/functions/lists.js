const { getStore, connectLambda } = require('@netlify/blobs');

const KEY = 'lists.json';
const DEFAULT_DATA = {
  watchlist: [],
  scanlist: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL'],
};

function store() {
  return getStore('stock-scanner-lists');
}

exports.handler = async (event) => {
  connectLambda(event); // required for Netlify Blobs in classic Lambda-compatible functions

  try {
    const s = store();

    if (event.httpMethod === 'GET') {
      const data = (await s.get(KEY, { type: 'json' })) || DEFAULT_DATA;
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      };
    }

    if (event.httpMethod === 'PUT') {
      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
      }
      const current = (await s.get(KEY, { type: 'json' })) || DEFAULT_DATA;
      const updated = {
        watchlist: Array.isArray(body.watchlist) ? body.watchlist.map((t) => t.toUpperCase()) : current.watchlist,
        scanlist: Array.isArray(body.scanlist) ? body.scanlist.map((t) => t.toUpperCase()) : current.scanlist,
      };
      await s.setJSON(KEY, updated);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      };
    }

    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Storage error', detail: String(err.message || err) }),
    };
  }
};
