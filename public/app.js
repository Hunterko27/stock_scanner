const DIAL_CIRCUMFERENCE = 2 * Math.PI * 50;

const state = {
  watchlist: [],
  scanlist: [],
  results: new Map(), // symbol -> analysis
};

const el = (sel, root = document) => root.querySelector(sel);
const elAll = (sel, root = document) => root.querySelectorAll(sel);

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

async function scanSymbol(symbol) {
  const res = await fetch(`/api/scan?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to scan ${symbol}`);
  }
  return res.json();
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

function renderCardShell(symbol) {
  const tpl = el('#card-template');
  const node = tpl.content.cloneNode(true);
  const card = node.querySelector('.stock-card');
  card.dataset.symbol = symbol;
  el('.ticker', card).textContent = symbol;
  return card;
}

function renderCardLoading(card) {
  el('.price', card).textContent = 'Loading…';
  el('.overall-label', card).textContent = '';
}

function renderCardError(card, message) {
  const panel = el('.tf-panel', card);
  panel.innerHTML = `<div class="card-status">${message}</div>`;
  el('.sparkline-wrap', card).style.display = 'none';
  el('.tf-tabs', card).style.display = 'none';
}

function renderSignalChips(container, signals) {
  container.innerHTML = '';
  signals
    .filter((s) => s.type !== 'info')
    .forEach((s) => {
      const chip = document.createElement('span');
      chip.className = `chip ${s.type}`;
      chip.textContent = s.label;
      container.appendChild(chip);
    });
  const info = signals.find((s) => s.type === 'info');
  if (info) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = info.label;
    container.appendChild(chip);
  }
}

function renderTimeframePanel(panelEl, tf) {
  if (!tf || tf.insufficientData) {
    panelEl.innerHTML = '<div class="card-status">Not enough history yet for this timeframe.</div>';
    return;
  }
  panelEl.innerHTML = `
    <div class="metric-row"><span>Price</span><span>$${tf.price}</span></div>
    <div class="metric-row"><span>RSI (14)</span><span>${tf.rsi ?? '—'}</span></div>
    <div class="metric-row"><span>Bollinger</span><span>${tf.bollinger ? `${tf.bollinger.lower} – ${tf.bollinger.upper}` : '—'}</span></div>
    <div class="metric-row"><span>SMA20 / SMA50 / SMA200</span><span>${tf.sma20 ?? '—'} / ${tf.sma50 ?? '—'} / ${tf.sma200 ?? '—'}</span></div>
    <div class="metric-row"><span>Fib golden zone</span><span>${tf.fib ? `${tf.fib.goldenLow.toFixed(2)} – ${tf.fib.goldenHigh.toFixed(2)}` : '—'}</span></div>
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

  el('.price', card).textContent = analysis.timeframes['1d'] && !analysis.timeframes['1d'].insufficientData
    ? `$${analysis.timeframes['1d'].price}`
    : '';

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
    drawSparkline(el('.sparkline', card), dailyCandles);
  }
}

async function renderList(symbols, gridId, emptyId, target) {
  const grid = el(`#${gridId}`);
  const emptyNote = el(`#${emptyId}`);
  grid.innerHTML = '';
  emptyNote.hidden = symbols.length > 0;
  if (!symbols.length) return;

  const cards = symbols.map((sym) => {
    const card = renderCardShell(sym);
    renderCardLoading(card);
    el('.remove-btn', card).addEventListener('click', () => removeSymbol(sym, target));
    grid.appendChild(card);
    return card;
  });

  const analyses = await Promise.all(
    symbols.map((sym) =>
      scanSymbol(sym)
        .then((a) => ({ sym, a }))
        .catch((err) => ({ sym, err }))
    )
  );

  // Sort scan list by overall score descending so best opportunities float up
  if (target === 'scanlist') {
    const scoreMap = new Map(analyses.map((r) => [r.sym, r.a ? r.a.overallScore ?? -1 : -1]));
    const ordered = [...symbols].sort((a, b) => (scoreMap.get(b) ?? -1) - (scoreMap.get(a) ?? -1));
    grid.innerHTML = '';
    ordered.forEach((sym) => {
      const found = cards.find((c) => c.dataset.symbol === sym);
      grid.appendChild(found);
    });
  }

  analyses.forEach(({ sym, a, err }) => {
    const card = cards.find((c) => c.dataset.symbol === sym);
    if (err) {
      renderCardError(card, err.message || 'Could not load data');
    } else {
      renderCardResult(card, a);
    }
  });
}

async function renderAll() {
  await Promise.all([
    renderList(state.watchlist, 'watchlist-grid', 'watchlist-empty', 'watchlist'),
    renderList(state.scanlist, 'scanlist-grid', 'scanlist-empty', 'scanlist'),
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

  el('#refresh-all').addEventListener('click', () => renderAll());
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
