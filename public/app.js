const DIAL_CIRCUMFERENCE = 2 * Math.PI * 50;

// How long a scan result stays valid before we're willing to re-fetch it.
// This matters a lot on Twelve Data's free tier (8 credits/min, 800/day) —
// without this, adding one stock would silently re-scan every other stock
// too, burning through the daily budget fast. 5 minutes rather than 90s,
// since a full load can itself take a minute or more.
const CACHE_TTL_MS = 5 * 60 * 1000;

const state = {
  watchlist: [],
  scanlist: [],
  results: new Map(), // symbol -> { analysis, fetchedAt }
  cardsByGrid: { watchlist: new Map(), scanlist: new Map() }, // symbol -> persisted card element
};

const el = (sel, root = document) => root.querySelector(sel);
const elAll = (sel, root = document) => root.querySelectorAll(sel);

// Twelve Data's free tier allows 8 API credits/minute, and each symbol scan
// uses 2 credits (4H + daily; weekly is derived locally) — so up to 4
// symbols can safely be dispatched at once. Rather than trickling scans out
// one at a time, fire a full batch immediately, then wait out the rest of
// the per-minute window before the next batch. For most watchlists (≤4
// stocks) this means everything loads almost immediately.
const BATCH_SIZE = 4;
const BATCH_WAIT_MS = 62000; // a little over a minute, safely past any window boundary
const scanQueue = [];
let dispatching = false;

function scheduleScan(task) {
  return new Promise((resolve, reject) => {
    scanQueue.push({ task, resolve, reject });
    if (!dispatching) {
      dispatching = true;
      // Deferred rather than called immediately: renderAll() schedules every
      // symbol's scan synchronously in the same tick, so without this defer,
      // the first batch would fire after only one item has been queued.
      setTimeout(dispatchBatch, 0);
    }
  });
}

function dispatchBatch() {
  if (!scanQueue.length) {
    dispatching = false;
    return;
  }
  const batch = scanQueue.splice(0, BATCH_SIZE);
  batch.forEach((job) => job.task().then(job.resolve, job.reject));
  if (scanQueue.length) {
    setTimeout(dispatchBatch, BATCH_WAIT_MS);
  } else {
    dispatching = false;
  }
}

async function loadLists() {
  const res = await fetch('/api/lists');
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ? `Could not load your lists: ${err.error}` : 'Could not load your lists.');
  }
  const data = await res.json();
  state.watchlist = data.watchlist || [];
  state.scanlist = data.scanlist || [];
}

async function saveLists() {
  const res = await fetch('/api/lists', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ watchlist: state.watchlist, scanlist: state.scanlist }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ? `Could not save your lists: ${err.error}` : 'Could not save your lists — changes may not persist.');
  }
}

async function scanSymbolOnce(symbol) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`/api/scan?symbol=${encodeURIComponent(symbol)}`, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error || `Failed to scan ${symbol}`);
      err.isRateLimit = !!body.isRateLimit;
      throw err;
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${symbol} took too long to respond`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// A rate-limit hit is expected occasionally on the free tier, especially
// right after several other stocks were just scanned. Retrying is safe to
// do here (the browser has no hard execution-time limit, unlike the
// serverless function), so wait for Twelve Data's per-minute window to
// clearly roll over, then try once more before giving up.
async function scanSymbol(symbol) {
  try {
    return await scanSymbolOnce(symbol);
  } catch (err) {
    if (!err.isRateLimit) throw err;
    await new Promise((resolve) => setTimeout(resolve, 15000));
    return scanSymbolOnce(symbol);
  }
}

function scoreColor(score) {
  if (score >= 75) return getComputedStyle(document.documentElement).getPropertyValue('--gold').trim();
  if (score <= 25) return getComputedStyle(document.documentElement).getPropertyValue('--brick').trim();
  return getComputedStyle(document.documentElement).getPropertyValue('--blue').trim();
}

function labelClass(label) {
  if (label === 'Golden Opportunity' || label === 'Building Setup') return 'golden';
  if (label === 'Overbought / Caution') return 'caution';
  return '';
}

function createCard(symbol) {
  const card = document.createElement('article');
  card.className = 'stock-card';
  card.dataset.symbol = symbol;
  return card;
}

// Wipes and rebuilds a card's inner content from the template. Always call
// this immediately before a genuine render (never for a cache-hit reuse) —
// it discards any previously-attached listeners along with the old nodes,
// so re-populating a persisted card never results in duplicate handlers.
function populateCardChildren(card, symbol) {
  const tpl = el('#card-template');
  const node = tpl.content.cloneNode(true);
  const fresh = node.querySelector('.stock-card');
  card.innerHTML = '';
  Array.from(fresh.children).forEach((child) => card.appendChild(child));
  el('.ticker', card).textContent = symbol;
}

function renderCardLoading(card) {
  el('.price', card).textContent = 'Loading…';
  el('.overall-label', card).textContent = '';
}

function renderCardError(card, message) {
  card.classList.remove('golden', 'caution');
  card.classList.add('caution');
  el('.price', card).textContent = '';
  el('.guidance-box', card).textContent = '';
  const labelEl = el('.overall-label', card);
  labelEl.textContent = 'Failed to load';
  labelEl.className = 'overall-label caution';
  el('.dial-score', card).textContent = '!';

  const panel = el('.tf-panel', card);
  panel.innerHTML = `<div class="card-status">${message}</div>`;
  el('.sparkline-wrap', card).style.display = 'none';
  el('.tf-tabs', card).style.display = 'none';
  elAll('.earnings-row', card).forEach((row) => { row.style.display = 'none'; });
}

function renderSignalChips(container, signals) {
  container.innerHTML = '';
  signals.forEach((s) => {
    const chip = document.createElement('span');
    chip.className = s.type === 'info' ? 'chip' : `chip ${s.type}`;
    chip.textContent = s.label;
    container.appendChild(chip);
  });
}

function formatExtensions(fib) {
  const dir = fib.direction === 'uptrend_pullback' ? '↑' : '↓';
  const nearer = ['1.272', '1.618'];
  return nearer
    .filter((r) => fib.extensions[r] != null)
    .map((r) => `${dir}$${fib.extensions[r].toFixed(2)} (${r})`)
    .join(', ');
}

function renderLevelLadder(tf) {
  if (!tf.levels) return '';
  const renderRows = (list, cls) =>
    list.length
      ? list.map((l) => `<div class="ladder-row ${cls}"><span class="ladder-price">$${l.price}</span><span class="ladder-label">${l.label}</span></div>`).join('')
      : '<div class="ladder-empty">None nearby</div>';

  return `
    <div class="ladder-section">
      <div class="ladder-title resistance">Resistance (sell zone)</div>
      ${renderRows(tf.levels.resistance, 'resistance')}
      <div class="ladder-title support">Support (buy zone)</div>
      ${renderRows(tf.levels.support, 'support')}
    </div>
  `;
}

// Major zones use much more history and rank by how many times a price
// area was actually retested, rather than just proximity — deliberately
// styled distinctly (a "major" badge on each row) so it reads as a
// different, longer-term kind of signal than the short-term ladder above.
// Two confidence tiers: a genuinely proven "Major level" (2+ real
// departures-and-returns spread across a long stretch of time) is styled
// bold; a single clean test falls back to a dimmer "Notable level" so it's
// never visually confused with the stronger, repeatedly-confirmed kind.
function renderMajorLevels(tf) {
  if (!tf.majorLevels) return '';
  const renderRows = (list, cls) =>
    list.length
      ? list.map((l) => {
          const confidence = l.touchCount >= 2 ? 'confirmed' : 'notable';
          return `<div class="ladder-row major ${cls} ${confidence}"><span class="ladder-price">$${l.price}</span><span class="ladder-label">${l.label}</span></div>`;
        }).join('')
      : '<div class="ladder-empty">No repeatedly-tested zone found nearby</div>';

  return `
    <div class="ladder-section major-section">
      <div class="ladder-title resistance">Major resistance (long-term)</div>
      ${renderRows(tf.majorLevels.resistance, 'resistance')}
      <div class="ladder-title support">Major support (long-term)</div>
      ${renderRows(tf.majorLevels.support, 'support')}
    </div>
  `;
}

function renderTimeframePanel(panelEl, tf) {
  if (!tf || tf.insufficientData) {
    panelEl.innerHTML = '<div class="card-status">Not enough history yet for this timeframe.</div>';
    return;
  }
  const longRangeRow = tf.longRangeFib
    ? `<div class="metric-row"><span>Fib golden zone (long-term)</span><span>$${tf.longRangeFib.goldenLow.toFixed(2)} – $${tf.longRangeFib.goldenHigh.toFixed(2)}</span></div>`
    : '';
  panelEl.innerHTML = `
    <div class="metric-row"><span>Price</span><span>$${tf.price}</span></div>
    <div class="metric-row"><span>RSI (14)</span><span>${tf.rsi ?? '—'}</span></div>
    <div class="metric-row"><span>Bollinger</span><span>${tf.bollinger ? `${tf.bollinger.lower} – ${tf.bollinger.upper}` : '—'}</span></div>
    <div class="metric-row"><span>SMA20 / SMA50 / SMA200</span><span>${tf.sma20 ?? '—'} / ${tf.sma50 ?? '—'} / ${tf.sma200 ?? '—'}</span></div>
    <div class="metric-row"><span>Fib golden zone${tf.fib && tf.fib.useLog ? ' (log)' : ''}</span><span>${tf.fib ? `$${tf.fib.goldenLow.toFixed(2)} – $${tf.fib.goldenHigh.toFixed(2)}` : '—'}</span></div>
    ${longRangeRow}
    <div class="metric-row"><span>Extension targets</span><span>${tf.fib && tf.fib.extensions ? formatExtensions(tf.fib) : '—'}</span></div>
    ${renderLevelLadder(tf)}
    ${renderMajorLevels(tf)}
    <div class="signal-chips"></div>
  `;
  renderSignalChips(el('.signal-chips', panelEl), tf.signals);
}

function drawSparkline(canvas, candles) {
  const labels = candles.map((c) => '');
  const data = candles.map((c) => c.close);
  new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          data,
          borderColor: '#D4A94D',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.15,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: { x: { display: false }, y: { display: false } },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
    },
  });
}

function renderCardResult(card, analysis) {
  card.classList.remove('golden', 'caution');
  const labCls = labelClass(analysis.overallLabel);
  if (labCls) card.classList.add(labCls);

  el('.guidance-box', card).textContent = analysis.guidance || '';

  // Prefer daily price, but fall back to weekly or 4H if daily happens to
  // have insufficient history (e.g. a recently-listed stock) — otherwise
  // the card can end up looking "golden but empty."
  const priceSource = ['1d', '1w', '4h']
    .map((k) => analysis.timeframes[k])
    .find((tf) => tf && !tf.insufficientData);
  el('.price', card).textContent = priceSource ? `$${priceSource.price}` : '';

  const labelEl = el('.overall-label', card);
  labelEl.textContent = analysis.overallLabel;
  labelEl.className = `overall-label ${labCls}`;

  const dialArc = el('.dial-arc', card);
  const dialScore = el('.dial-score', card);
  if (analysis.overallScore != null) {
    const offset = DIAL_CIRCUMFERENCE * (1 - analysis.overallScore / 100);
    dialArc.style.strokeDashoffset = offset;
    dialArc.style.stroke = scoreColor(analysis.overallScore);
    dialScore.textContent = analysis.overallScore;
  }

  const tfOrder = ['4h', '1d', '1w'];
  const tabsEl = el('.tf-tabs', card);
  tabsEl.innerHTML = '';
  tfOrder.forEach((key, i) => {
    const btn = document.createElement('button');
    btn.className = `tf-tab${i === 1 ? ' active' : ''}`;
    btn.textContent = key.toUpperCase();
    btn.dataset.tf = key;
    tabsEl.appendChild(btn);
  });

  const panelEl = el('.tf-panel', card);
  renderTimeframePanel(panelEl, analysis.timeframes['1d']);

  tabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.tf-tab');
    if (!btn) return;
    elAll('.tf-tab', tabsEl).forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderTimeframePanel(panelEl, analysis.timeframes[btn.dataset.tf]);
  });

  const dailyCandles = analysis.timeframes['1d'] && analysis.timeframes['1d'].candles;
  if (dailyCandles && dailyCandles.length) {
    if (typeof Chart !== 'undefined') {
      drawSparkline(el('.sparkline', card), dailyCandles);
    } else {
      console.warn('Chart.js failed to load — skipping sparkline, rest of the card still renders.');
      el('.sparkline-wrap', card).style.display = 'none';
    }
  }

  const earningsBtn = el('.earnings-btn', card);
  const earningsResult = el('.earnings-result', card);
  earningsBtn.addEventListener('click', async () => {
    earningsBtn.disabled = true;
    earningsBtn.textContent = 'Checking…';
    earningsResult.textContent = '';
    earningsResult.className = 'earnings-result';
    try {
      const res = await fetch(`/api/earnings?symbol=${encodeURIComponent(analysis.symbol)}`);
      const data = await res.json();
      if (!res.ok) {
        earningsResult.textContent = data.error || 'Could not check earnings.';
        earningsResult.className = 'earnings-result warn';
      } else if (data.nextEarningsDate == null) {
        earningsResult.textContent = 'No earnings date found.';
      } else if (data.isPast) {
        earningsResult.textContent = `Most recent earnings: ${data.nextEarningsDate} (no upcoming date listed yet).`;
      } else {
        const soon = data.daysUntil <= 7;
        earningsResult.textContent = `Next earnings: ${data.nextEarningsDate} (${data.daysUntil} day${data.daysUntil === 1 ? '' : 's'} away)${soon ? ' — expect volatility around this date' : ''}.`;
        if (soon) earningsResult.className = 'earnings-result warn';
      }
    } catch (err) {
      earningsResult.textContent = 'Could not check earnings — try again shortly.';
      earningsResult.className = 'earnings-result warn';
    } finally {
      earningsBtn.disabled = false;
      earningsBtn.textContent = 'Check earnings date';
    }
  });

  const peBtn = el('.pe-btn', card);
  const peResult = el('.pe-result', card);
  peBtn.addEventListener('click', async () => {
    peBtn.disabled = true;
    peBtn.textContent = 'Checking…';
    peResult.textContent = '';
    peResult.className = 'pe-result';
    try {
      const res = await fetch(`/api/pe?symbol=${encodeURIComponent(analysis.symbol)}`);
      const data = await res.json();
      if (!res.ok) {
        peResult.textContent = data.error || 'Could not check P/E ratio.';
        peResult.className = 'pe-result warn';
      } else if (data.trailingPE == null && data.forwardPE == null) {
        peResult.textContent = 'No P/E data available (may not be profitable, or Yahoo has no data for this symbol).';
      } else {
        const parts = [];
        if (data.trailingPE != null) parts.push(`Trailing P/E: ${data.trailingPE.toFixed(1)}`);
        if (data.forwardPE != null) parts.push(`Forward P/E: ${data.forwardPE.toFixed(1)}`);
        peResult.textContent = parts.join(' | ');
      }
    } catch (err) {
      peResult.textContent = 'Could not check P/E ratio — try again shortly.';
      peResult.className = 'pe-result warn';
    } finally {
      peBtn.disabled = false;
      peBtn.textContent = 'Check P/E ratio';
    }
  });
}

async function renderList(symbols, gridId, emptyId, target, forceRefresh = false) {
  const grid = el(`#${gridId}`);
  const emptyNote = el(`#${emptyId}`);
  emptyNote.hidden = symbols.length > 0;

  const existingCards = state.cardsByGrid[target];
  const symbolSet = new Set(symbols);

  // Remove cards for symbols no longer in the list
  for (const [sym, cardEl] of existingCards) {
    if (!symbolSet.has(sym)) {
      cardEl.remove();
      existingCards.delete(sym);
    }
  }

  // Ensure every symbol has a card, creating (and appending) any that are new.
  // Content is populated below, in the fetch step — every brand-new card is
  // by definition not cache-fresh, so it'll always go through that path.
  symbols.forEach((sym) => {
    if (!existingCards.has(sym)) {
      const card = createCard(sym);
      existingCards.set(sym, card);
      grid.appendChild(card);
    }
  });

  if (!symbols.length) return;

  const analyses = await Promise.all(
    symbols.map((sym) => {
      const cached = !forceRefresh && state.results.get(sym);
      const isFresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS;
      if (isFresh) {
        // Already displayed correctly from a previous render — skip entirely,
        // no network call, no DOM changes, no flicker.
        return Promise.resolve({ sym, a: cached.analysis, skipRender: true });
      }
      const card = existingCards.get(sym);
      // Rebuild this card's inner content fresh before showing "Loading…" —
      // guards against duplicate listeners if this card already existed
      // and is now being genuinely re-fetched (e.g. cache expired).
      populateCardChildren(card, sym);
      el('.remove-btn', card).addEventListener('click', () => removeSymbol(sym, target));
      renderCardLoading(card);
      return scheduleScan(() => scanSymbol(sym))
        .then((a) => {
          state.results.set(sym, { analysis: a, fetchedAt: Date.now() });
          return { sym, a, skipRender: false };
        })
        .catch((err) => ({ sym, err, skipRender: false }));
    })
  );

  // Sort scan list by overall score descending so best opportunities float
  // up — reorders the existing DOM nodes rather than rebuilding the grid.
  if (target === 'scanlist') {
    const scoreMap = new Map(analyses.map((r) => [r.sym, r.a ? r.a.overallScore ?? -1 : -1]));
    const ordered = [...symbols].sort((a, b) => (scoreMap.get(b) ?? -1) - (scoreMap.get(a) ?? -1));
    ordered.forEach((sym) => grid.appendChild(existingCards.get(sym)));
  }

  analyses.forEach(({ sym, a, err, skipRender }) => {
    if (skipRender) return;
    const card = existingCards.get(sym);
    try {
      if (err) {
        renderCardError(card, err.message || 'Could not load data');
      } else {
        renderCardResult(card, a);
      }
    } catch (renderErr) {
      // A rendering bug for one card should never block the rest of the grid.
      console.error(`Failed to render ${sym}:`, renderErr);
      renderCardError(card, 'Something went wrong displaying this stock.');
    }
  });
}

async function renderAll(forceRefresh = false) {
  await Promise.all([
    renderList(state.watchlist, 'watchlist-grid', 'watchlist-empty', 'watchlist', forceRefresh),
    renderList(state.scanlist, 'scanlist-grid', 'scanlist-empty', 'scanlist', forceRefresh),
  ]);
}

function showError(message) {
  const banner = el('#error-banner');
  banner.textContent = message;
  banner.hidden = false;
}

function clearError() {
  el('#error-banner').hidden = true;
}

async function addSymbol(symbol, target) {
  const sym = symbol.trim().toUpperCase();
  if (!sym) return;
  const list = state[target];
  if (!list.includes(sym)) list.push(sym);
  try {
    await saveLists();
    clearError();
  } catch (err) {
    showError(err.message);
  }
  await renderAll();
}

async function removeSymbol(symbol, target) {
  state[target] = state[target].filter((s) => s !== symbol);
  try {
    await saveLists();
    clearError();
  } catch (err) {
    showError(err.message);
  }
  await renderAll();
}

function wireForm() {
  el('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = el('#add-symbol');
    const target = el('#add-target').value;
    await addSymbol(input.value, target);
    input.value = '';
  });

  el('#refresh-all').addEventListener('click', () => renderAll(true));
}

(async function init() {
  wireForm();
  try {
    await loadLists();
    clearError();
  } catch (err) {
    showError(err.message);
  }
  await renderAll();
})();
