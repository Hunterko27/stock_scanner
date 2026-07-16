const { analyzeSymbol } = require('./lib/analysis');

exports.handler = async (event) => {
  const symbol = (event.queryStringParameters && event.queryStringParameters.symbol || '').trim().toUpperCase();

  if (!symbol) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing symbol query parameter' }),
    };
  }

  try {
    const analysis = await analyzeSymbol(symbol);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify(analysis),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Could not fetch data for ${symbol}`, detail: String(err.message || err) }),
    };
  }
};
