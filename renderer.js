'use strict';

/* ═══════════════════════════════════════════════════════════════════════════════
   Utility helpers
═══════════════════════════════════════════════════════════════════════════════ */
function fmtBytes(b) {
  if (b == null || isNaN(b)) return '—';
  if (b < 1024)        return `${b} B`;
  if (b < 1048576)     return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824)  return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

function fmtSpeed(bps) {
  if (!bps || bps < 0) return '— /s';
  return fmtBytes(bps) + '/s';
}

function fmtSpeedAxis(bps) {
  if (bps === 0) return '0';
  if (bps >= 1073741824) return `${(bps / 1073741824).toFixed(1)}G/s`;
  if (bps >= 1048576)    return `${(bps / 1048576).toFixed(bps >= 10485760 ? 0 : 1)}M/s`;
  if (bps >= 1024)       return `${(bps / 1024).toFixed(bps >= 10240 ? 0 : 1)}K/s`;
  return `${bps.toFixed(0)}B/s`;
}

function fmtTime(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function niceScale(maxVal, targetSteps) {
  if (!maxVal || maxVal <= 0) return [0];
  const rawStep = maxVal / targetSteps;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  let step;
  if (norm < 1.5) step = 1;
  else if (norm < 3.5) step = 2;
  else if (norm < 7.5) step = 5;
  else step = 10;
  step *= mag;
  const ticks = [];
  for (let v = 0; v <= maxVal * 1.15; v += step) {
    ticks.push(Math.round(v * 1e10) / 1e10);
  }
  return ticks;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   Speed Chart
═══════════════════════════════════════════════════════════════════════════════ */
class SpeedChart {
  constructor(canvasEl) {
    this.canvas   = canvasEl;
    this.ctx      = canvasEl.getContext('2d');
    this.samples  = [];        // { time: number, speed: number }
    this.windowMs = 60_000;
    this.w = 0; this.h = 0; this.dpr = 1;
    this._raf = null;
    this._resizeObs = new ResizeObserver(() => this._resize());
    this._resizeObs.observe(canvasEl.parentElement);
    this._resize();
  }

  _resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr  = window.devicePixelRatio || 1;
    this.dpr   = dpr;
    this.w     = rect.width;
    this.h     = rect.height;
    this.canvas.width  = Math.round(rect.width  * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.canvas.style.width  = rect.width  + 'px';
    this.canvas.style.height = rect.height + 'px';
    this._draw();
  }

  addSample(speed) {
    this.samples.push({ time: Date.now(), speed });
    const cutoff = Date.now() - this.windowMs;
    while (this.samples.length && this.samples[0].time < cutoff) this.samples.shift();
  }

  startLoop() {
    if (this._raf) return;
    const loop = () => { this._draw(); this._raf = requestAnimationFrame(loop); };
    this._raf = requestAnimationFrame(loop);
  }

  stopLoop() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    this._draw();
  }

  _draw() {
    const { ctx, w, h, dpr, samples } = this;
    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, w, h);

    const PAD = { top: 18, right: 20, bottom: 30, left: 64 };
    const cw = w - PAD.left - PAD.right;
    const ch = h - PAD.top  - PAD.bottom;

    if (cw <= 0 || ch <= 0) { ctx.restore(); return; }

    const now  = Date.now();
    const xMin = now - this.windowMs;
    const xMax = now;

    const toX = t  => PAD.left + ((t - xMin) / (xMax - xMin)) * cw;
    const toY = sp => PAD.top  + ch - (sp / maxSpeed) * ch;

    // ── Compute Y scale ──
    const maxRaw   = samples.length ? Math.max(...samples.map(s => s.speed)) : 0;
    const maxSpeed = maxRaw > 0 ? maxRaw * 1.2 : 1024 * 100; // default 100 KB/s baseline
    const yTicks   = niceScale(maxSpeed, 4);

    // ── Grid lines ──
    ctx.strokeStyle = '#25252f';
    ctx.lineWidth   = 1;
    ctx.setLineDash([]);
    for (const tick of yTicks) {
      const y = toY(tick);
      if (y < PAD.top - 2 || y > PAD.top + ch + 2) continue;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + cw, y);
      ctx.stroke();
      ctx.fillStyle    = '#55555f';
      ctx.font         = `10px monospace`;
      ctx.textAlign    = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(fmtSpeedAxis(tick), PAD.left - 6, y);
    }

    // X grid + labels (every 10 s)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let sec = 0; sec <= 60; sec += 10) {
      const x = toX(now - sec * 1000);
      if (x < PAD.left || x > PAD.left + cw) continue;
      ctx.strokeStyle = '#25252f';
      ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + ch); ctx.stroke();
      ctx.fillStyle = '#55555f';
      ctx.fillText(`-${sec}s`, x, PAD.top + ch + 6);
    }

    // ── Axes ──
    ctx.strokeStyle = '#38384a';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(PAD.left, PAD.top);
    ctx.lineTo(PAD.left, PAD.top + ch);
    ctx.lineTo(PAD.left + cw, PAD.top + ch);
    ctx.stroke();

    if (samples.length < 2) {
      ctx.restore();
      return;
    }

    const pts = samples.map(s => ({ x: toX(s.time), y: toY(s.speed) }));
    // Clamp y to chart bounds
    for (const p of pts) p.y = Math.max(PAD.top, Math.min(PAD.top + ch, p.y));

    // ── Area fill ──
    const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + ch);
    grad.addColorStop(0,   'rgba(79,142,255,.22)');
    grad.addColorStop(0.7, 'rgba(79,142,255,.05)');
    grad.addColorStop(1,   'rgba(79,142,255,.00)');

    ctx.beginPath();
    ctx.moveTo(pts[0].x, PAD.top + ch);
    ctx.lineTo(pts[0].x, pts[0].y);
    _smoothThrough(ctx, pts);
    ctx.lineTo(pts[pts.length - 1].x, PAD.top + ch);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // ── Speed line ──
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    _smoothThrough(ctx, pts);
    ctx.strokeStyle = '#4f8eff';
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.setLineDash([]);
    ctx.stroke();

    // ── Live marker ──
    const last = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(79,142,255,.25)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#4f8eff';
    ctx.fill();

    ctx.restore();
  }
}

function _smoothThrough(ctx, pts) {
  for (let i = 0; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   App State
═══════════════════════════════════════════════════════════════════════════════ */
const state = {
  csvPath:    null,
  folderPath: null,
  urls:       [],
  failedUrls: [],   // for retry
  phase:      'idle',  // idle | downloading | done | cancelled
  unsubs:     [],      // IPC unsubscribe callbacks
};

// DOM refs – setup
const csvPathEl       = document.getElementById('csvPath');
const csvCountEl      = document.getElementById('csvCount');
const csvBrowseBtn    = document.getElementById('csvBrowse');
const folderPathEl    = document.getElementById('folderPath');
const folderBrowseBtn = document.getElementById('folderBrowse');
const concSlider      = document.getElementById('concurrencySlider');
const concVal         = document.getElementById('concurrencyVal');
const btnStart        = document.getElementById('btnStart');
const btnCancel       = document.getElementById('btnCancel');
const btnRetry        = document.getElementById('btnRetry');
const btnReset        = document.getElementById('btnReset');
const retryCountEl    = document.getElementById('retryCount');

// DOM refs – dashboard
const overallStatus   = document.getElementById('overallStatus');
const ringFill        = document.getElementById('ringFill');
const ringPct         = document.getElementById('ringPct');
const ringSub         = document.getElementById('ringSub');
const statCompleted   = document.getElementById('statCompleted');
const statFailed      = document.getElementById('statFailed');
const statActive      = document.getElementById('statActive');
const statQueued      = document.getElementById('statQueued');
const statDL          = document.getElementById('statDL');
const statTotal       = document.getElementById('statTotal');
const statElapsed     = document.getElementById('statElapsed');
const statETA         = document.getElementById('statETA');
const currentSpeedEl  = document.getElementById('currentSpeed');
const chartPlaceholder= document.getElementById('chartPlaceholder');

// DOM refs – file list
const fileListEl      = document.getElementById('fileList');
const fileListEmpty   = document.getElementById('fileListEmpty');

// Ring circumference (r=52 → 2π·52 ≈ 326.73)
const RING_CIRC = 2 * Math.PI * 52;

// Context menu
const ctxMenu = document.createElement('div');
ctxMenu.id = 'fileContextMenu';
ctxMenu.className = 'ctx-menu hidden';
ctxMenu.innerHTML = '<button class="ctx-menu-item" id="ctxShowInFolder">📂 Show in Folder</button>';
document.body.appendChild(ctxMenu);

let ctxMenuTargetFilePath = null;

function showCtxMenu(x, y, filePath) {
  ctxMenuTargetFilePath = filePath;
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top  = y + 'px';
  ctxMenu.classList.remove('hidden');
  // Reposition if it overflows the viewport
  const rect = ctxMenu.getBoundingClientRect();
  if (rect.right  > window.innerWidth)  ctxMenu.style.left = (x - rect.width)  + 'px';
  if (rect.bottom > window.innerHeight) ctxMenu.style.top  = (y - rect.height) + 'px';
}

function hideCtxMenu() {
  ctxMenu.classList.add('hidden');
  ctxMenuTargetFilePath = null;
}

document.getElementById('ctxShowInFolder').addEventListener('click', () => {
  if (ctxMenuTargetFilePath) window.electronAPI.showInFolder(ctxMenuTargetFilePath);
  hideCtxMenu();
});

document.addEventListener('click',  hideCtxMenu);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideCtxMenu(); });

// Chart
const chart = new SpeedChart(document.getElementById('speedChart'));

// File row cache: idx → { row, fill, pct, size, speed, status }
const rowCache = new Map();

// Active filter
let activeFilter = 'all';

/* ═══════════════════════════════════════════════════════════════════════════════
   Deferred DOM update batching
═══════════════════════════════════════════════════════════════════════════════ */
const pendingRowData = new Map(); // idx → partial state
let rafPending = false;

function scheduleRowUpdate(idx, patch) {
  pendingRowData.set(idx, Object.assign(pendingRowData.get(idx) || {}, patch));
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(flushRows);
  }
}

function flushRows() {
  rafPending = false;
  for (const [idx, data] of pendingRowData) {
    applyRowPatch(idx, data);
  }
  pendingRowData.clear();
}

/* ═══════════════════════════════════════════════════════════════════════════════
   File row management
═══════════════════════════════════════════════════════════════════════════════ */
function createRow(idx, url) {
  const row = document.createElement('div');
  row.className   = 'file-row';
  row.dataset.status = 'queued';
  row.dataset.idx    = idx;

  const dot = document.createElement('div');
  dot.className = 'file-dot';

  const nameCol = document.createElement('div');
  nameCol.className = 'file-name-col';
  const nameEl = document.createElement('div');
  nameEl.className = 'file-name';
  nameEl.title = url;
  nameEl.textContent = url.split('/').pop() || url;
  const urlEl = document.createElement('div');
  urlEl.className  = 'file-url';
  urlEl.textContent = url;
  nameCol.append(nameEl, urlEl);

  const progCol = document.createElement('div');
  progCol.className = 'file-progress-col';
  const bar = document.createElement('div');
  bar.className = 'file-progress-bar';
  const fill = document.createElement('div');
  fill.className = 'file-progress-fill';
  bar.appendChild(fill);
  const pct = document.createElement('div');
  pct.className = 'file-pct';
  pct.textContent = '';
  progCol.append(bar, pct);

  const sizeEl   = document.createElement('div'); sizeEl.className   = 'file-size';
  const speedEl  = document.createElement('div'); speedEl.className  = 'file-speed';
  const statusEl = document.createElement('div'); statusEl.className = 'file-status-text';
  statusEl.textContent = 'Queued';

  row.append(dot, nameCol, progCol, sizeEl, speedEl, statusEl);

  rowCache.set(idx, { row, nameEl, fill, pct, sizeEl, speedEl, statusEl });
  return row;
}

function applyRowPatch(idx, data) {
  const refs = rowCache.get(idx);
  if (!refs) return;
  const { row, nameEl, fill, pct, sizeEl, speedEl, statusEl } = refs;

  if (data.status !== undefined) row.dataset.status = data.status;
  if (data.filename)             { nameEl.textContent = data.filename; nameEl.title = nameEl.title || data.filename; }

  if (data.pct !== undefined) {
    fill.style.width  = data.pct + '%';
    pct.textContent   = data.pct > 0 ? data.pct + '%' : '';
  }
  if (data.sizeText  !== undefined) sizeEl.textContent   = data.sizeText;
  if (data.speedText !== undefined) speedEl.textContent  = data.speedText;
  if (data.statusText !== undefined) statusEl.textContent = data.statusText;

  // Filter visibility
  applyFilterToRow(row);
}

function applyFilterToRow(row) {
  const s = row.dataset.status;
  const visible = activeFilter === 'all' || activeFilter === s;
  row.style.display = visible ? '' : 'none';
}

/* ═══════════════════════════════════════════════════════════════════════════════
   UI state helpers
═══════════════════════════════════════════════════════════════════════════════ */
function setChip(text, cls) {
  overallStatus.textContent = text;
  overallStatus.className   = `status-chip ${cls}`;
}

function setRing(pctFraction) {
  const offset = RING_CIRC * (1 - Math.min(1, Math.max(0, pctFraction)));
  ringFill.style.strokeDashoffset = offset.toFixed(2);
}

function updateOverallStats(tick) {
  const { total, completed, failed, active, queued, downloadedBytes, totalBytes, speed, elapsed, eta } = tick;

  const pct = total > 0 ? Math.floor(((completed + failed) / total) * 100) : 0;
  setRing(pct / 100);
  ringPct.textContent = pct + '%';
  ringSub.textContent = `${completed + failed} / ${total}`;

  statCompleted.textContent = completed;
  statFailed.textContent    = failed;
  statActive.textContent    = active;
  statQueued.textContent    = queued;
  statDL.textContent        = fmtBytes(downloadedBytes);
  statTotal.textContent     = totalBytes > 0 ? fmtBytes(totalBytes) : '—';
  statElapsed.textContent   = fmtTime(elapsed);
  statETA.textContent       = eta != null ? fmtTime(eta * 1000) : '—';
  currentSpeedEl.textContent = fmtSpeed(speed);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   IPC event wiring
═══════════════════════════════════════════════════════════════════════════════ */
function subscribeIPC() {
  unsubscribeIPC();

  state.unsubs.push(
    window.electronAPI.on('file:queued', ({ idx, url }) => {
      if (!rowCache.has(idx)) {
        fileListEmpty.style.display = 'none';
        const row = createRow(idx, url);
        fileListEl.appendChild(row);
      }
    }),

    window.electronAPI.on('file:started', ({ idx, filename }) => {
      scheduleRowUpdate(idx, {
        status:     'active',
        filename,
        statusText: 'Downloading',
        speedText:  '',
        sizeText:   '',
      });
    }),

    window.electronAPI.on('file:progress', ({ idx, downloaded, total, speed }) => {
      const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
      scheduleRowUpdate(idx, {
        pct,
        sizeText:  total > 0 ? `${fmtBytes(downloaded)} / ${fmtBytes(total)}` : fmtBytes(downloaded),
        speedText: fmtSpeed(speed),
        statusText: pct + '%',
      });
    }),

    window.electronAPI.on('file:done', ({ idx, filename, filePath, size, elapsed }) => {
      const refs = rowCache.get(idx);
      if (refs) refs.filePath = filePath;
      scheduleRowUpdate(idx, {
        status:     'done',
        filename,
        pct:        100,
        sizeText:   fmtBytes(size),
        speedText:  '',
        statusText: `✓ ${fmtTime(elapsed)}`,
      });
    }),

    window.electronAPI.on('file:failed', ({ idx, url, error }) => {
      scheduleRowUpdate(idx, {
        status:     'failed',
        pct:        0,
        sizeText:   '',
        speedText:  '',
        statusText: `✗ ${error}`,
      });
      state.failedUrls.push(url);
    }),

    window.electronAPI.on('downloads:tick', (tick) => {
      chart.addSample(tick.speed);
      if (chartPlaceholder.style.display !== 'none') {
        chartPlaceholder.style.display = 'none';
      }
      updateOverallStats(tick);
    }),

    window.electronAPI.on('downloads:done', (info) => {
      chart.stopLoop();
      state.phase = 'done';
      setChip('Done', 'chip-done');
      updateOverallStats({
        total:          info.total,
        completed:      info.completed,
        failed:         info.failed,
        active:         0,
        queued:         0,
        downloadedBytes: null,
        totalBytes:     null,
        speed:          0,
        elapsed:        info.elapsed,
        eta:            null,
      });
      setRing(info.total > 0 ? (info.completed + info.failed) / info.total : 1);
      ringPct.textContent = Math.round(((info.completed + info.failed) / (info.total || 1)) * 100) + '%';
      ringSub.textContent = `${info.completed + info.failed} / ${info.total}`;
      btnCancel.classList.add('hidden');
      btnReset.classList.remove('hidden');
      if (state.failedUrls.length) {
        retryCountEl.textContent = state.failedUrls.length;
        btnRetry.classList.remove('hidden');
      }
      btnStart.disabled = true;
    }),

    window.electronAPI.on('downloads:cancelled', () => {
      chart.stopLoop();
      state.phase = 'cancelled';
      setChip('Cancelled', 'chip-cancelled');
      btnCancel.classList.add('hidden');
      btnReset.classList.remove('hidden');
      if (state.failedUrls.length) {
        retryCountEl.textContent = state.failedUrls.length;
        btnRetry.classList.remove('hidden');
      }
    }),
  );
}

function unsubscribeIPC() {
  for (const unsub of state.unsubs) unsub();
  state.unsubs = [];
}

/* ═══════════════════════════════════════════════════════════════════════════════
   Session management
═══════════════════════════════════════════════════════════════════════════════ */
function beginDownloads(urls) {
  state.failedUrls = [];
  // Clear file list
  while (fileListEl.firstChild) fileListEl.removeChild(fileListEl.firstChild);
  fileListEl.appendChild(fileListEmpty);
  fileListEmpty.style.display = 'flex';
  rowCache.clear();
  pendingRowData.clear();

  // Reset dashboard
  setRing(0);
  ringPct.textContent = '0%';
  ringSub.textContent = `0 / ${urls.length}`;
  setChip('Running', 'chip-running');
  [statCompleted, statFailed, statActive, statQueued, statDL, statTotal, statElapsed, statETA]
    .forEach(el => el.textContent = '—');
  currentSpeedEl.textContent = '— /s';
  chart.samples = [];
  chartPlaceholder.style.display = '';
  chart.startLoop();

  // Button states
  btnStart.classList.add('hidden');
  btnCancel.classList.remove('hidden');
  btnRetry.classList.add('hidden');
  btnReset.classList.add('hidden');

  state.phase = 'downloading';
  subscribeIPC();

  window.electronAPI.startDownloads({
    urls,
    destFolder:  state.folderPath,
    concurrency: parseInt(concSlider.value, 10),
  });
}

function resetSession() {
  unsubscribeIPC();
  chart.stopLoop();
  state.phase = 'idle';
  state.failedUrls = [];

  while (fileListEl.firstChild) fileListEl.removeChild(fileListEl.firstChild);
  fileListEl.appendChild(fileListEmpty);
  fileListEmpty.style.display = 'flex';
  rowCache.clear();
  pendingRowData.clear();

  setRing(0);
  ringPct.textContent = '0%';
  ringSub.textContent = '0 / 0';
  setChip('Idle', 'chip-idle');
  [statCompleted, statFailed, statActive, statQueued, statDL, statTotal, statElapsed, statETA]
    .forEach(el => el.textContent = '—');
  currentSpeedEl.textContent = '— /s';
  chart.samples = [];
  chart._draw();
  chartPlaceholder.style.display = '';

  btnStart.classList.remove('hidden');
  btnCancel.classList.add('hidden');
  btnRetry.classList.add('hidden');
  btnReset.classList.add('hidden');
  checkStartEnabled();
}

/* ═══════════════════════════════════════════════════════════════════════════════
   Setup panel event handlers
═══════════════════════════════════════════════════════════════════════════════ */
function checkStartEnabled() {
  btnStart.disabled = !(state.csvPath && state.folderPath && state.urls.length > 0 && state.phase === 'idle');
}

csvBrowseBtn.addEventListener('click', async () => {
  const p = await window.electronAPI.openCSV();
  if (!p) return;
  state.csvPath     = p;
  csvPathEl.value   = p;
  csvCountEl.classList.add('hidden');
  const result = await window.electronAPI.parseCSV(p);
  if (result.ok) {
    state.urls = result.urls;
    csvCountEl.textContent = `${result.count} URL${result.count !== 1 ? 's' : ''}`;
    csvCountEl.classList.remove('hidden');
  } else {
    state.urls = [];
    csvCountEl.textContent = 'Parse error';
    csvCountEl.classList.remove('hidden');
  }
  checkStartEnabled();
});

folderBrowseBtn.addEventListener('click', async () => {
  const p = await window.electronAPI.openFolder();
  if (!p) return;
  state.folderPath    = p;
  folderPathEl.value  = p;
  checkStartEnabled();
});

csvPathEl.addEventListener('change', async () => {
  const p = csvPathEl.value.trim();
  state.csvPath = p || null;
  csvCountEl.classList.add('hidden');
  if (!p) { state.urls = []; checkStartEnabled(); return; }
  const result = await window.electronAPI.parseCSV(p);
  if (result.ok) {
    state.urls = result.urls;
    csvCountEl.textContent = `${result.count} URL${result.count !== 1 ? 's' : ''}`;
    csvCountEl.classList.remove('hidden');
  } else {
    state.urls = [];
    csvCountEl.textContent = 'Parse error';
    csvCountEl.classList.remove('hidden');
  }
  checkStartEnabled();
});

folderPathEl.addEventListener('change', () => {
  const p = folderPathEl.value.trim();
  state.folderPath = p || null;
  checkStartEnabled();
});

/* ═══════════════════════════════════════════════════════════════════════════════
   Drag-and-drop
═══════════════════════════════════════════════════════════════════════════════ */
async function handleCSVDrop(p) {
  state.csvPath   = p;
  csvPathEl.value = p;
  csvCountEl.classList.add('hidden');
  const result = await window.electronAPI.parseCSV(p);
  if (result.ok) {
    state.urls = result.urls;
    csvCountEl.textContent = `${result.count} URL${result.count !== 1 ? 's' : ''}`;
    csvCountEl.classList.remove('hidden');
  } else {
    state.urls = [];
    csvCountEl.textContent = 'Parse error';
    csvCountEl.classList.remove('hidden');
  }
  checkStartEnabled();
}

const csvInputGroup    = csvPathEl.closest('.setup-input-group');
const folderInputGroup = folderPathEl.closest('.setup-input-group');

csvInputGroup.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer.items[0]?.kind === 'file') {
    e.dataTransfer.dropEffect = 'copy';
    csvInputGroup.classList.add('drag-over');
  }
});
csvInputGroup.addEventListener('dragleave', (e) => {
  if (!csvInputGroup.contains(e.relatedTarget)) {
    csvInputGroup.classList.remove('drag-over');
  }
});
csvInputGroup.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  csvInputGroup.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (!file?.path) return;
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext !== 'csv' && ext !== 'txt') return;
  await handleCSVDrop(file.path);
});

folderInputGroup.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const entry = e.dataTransfer.items[0]?.webkitGetAsEntry?.();
  if (entry?.isDirectory) {
    e.dataTransfer.dropEffect = 'copy';
    folderInputGroup.classList.add('drag-over');
  }
});
folderInputGroup.addEventListener('dragleave', (e) => {
  if (!folderInputGroup.contains(e.relatedTarget)) {
    folderInputGroup.classList.remove('drag-over');
  }
});
folderInputGroup.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  folderInputGroup.classList.remove('drag-over');
  const entry = e.dataTransfer.items[0]?.webkitGetAsEntry?.();
  if (!entry?.isDirectory) return;
  const file = e.dataTransfer.files[0];
  if (!file?.path) return;
  state.folderPath   = file.path;
  folderPathEl.value = file.path;
  checkStartEnabled();
});

concSlider.addEventListener('input', () => {
  concVal.textContent = concSlider.value;
});

// Right-click on a completed file row → show context menu
fileListEl.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.file-row');
  if (!row || row.dataset.status !== 'done') return;
  const idx = parseInt(row.dataset.idx, 10);
  const refs = rowCache.get(idx);
  if (!refs || !refs.filePath) return;
  e.preventDefault();
  showCtxMenu(e.clientX, e.clientY, refs.filePath);
});

btnStart.addEventListener('click', () => {
  if (state.phase !== 'idle' || !state.urls.length) return;
  beginDownloads([...state.urls]);
});

btnCancel.addEventListener('click', () => {
  if (state.phase !== 'downloading') return;
  window.electronAPI.cancelDownloads();
});

btnRetry.addEventListener('click', () => {
  if (!state.failedUrls.length) return;
  state.phase = 'idle';
  beginDownloads([...state.failedUrls]);
});

btnReset.addEventListener('click', resetSession);

/* ═══════════════════════════════════════════════════════════════════════════════
   Filter buttons
═══════════════════════════════════════════════════════════════════════════════ */
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    for (const { row } of rowCache.values()) applyFilterToRow(row);
  });
});

/* ─── Init ───────────────────────────────────────────────────────────────────── */
checkStartEnabled();

/* ═══════════════════════════════════════════════════════════════════════════════
   About modal
═══════════════════════════════════════════════════════════════════════════════ */
const aboutOverlay = document.getElementById('aboutOverlay');
const aboutClose   = document.getElementById('aboutClose');

async function openAboutModal() {
  // Populate dynamic fields
  try {
    const info = await window.electronAPI.getVersionInfo();
    document.getElementById('aboutAppName').textContent    = info.name        || 'CSV Links Downloader';
    document.getElementById('aboutVersion').textContent    = 'v' + (info.version || '1.0.0');
    document.getElementById('aboutDescription').textContent = info.description || '';
    document.getElementById('aboutAuthor').textContent     = info.author      || '—';
    document.getElementById('aboutBuildDate').textContent  = new Date().toISOString().slice(0, 10);
    document.getElementById('aboutElectron').textContent   = info.electron    || '—';
    document.getElementById('aboutNode').textContent       = info.node        || '—';
    document.getElementById('aboutChrome').textContent     = info.chrome      || '—';
    document.getElementById('aboutCopyright').textContent  = info.copyright   || '—';
    document.getElementById('aboutFooter').textContent     = info.copyright   || '—';
  } catch (_) { /* non-fatal */ }

  aboutOverlay.classList.remove('hidden');
  aboutClose.focus();
}

function closeAboutModal() {
  aboutOverlay.classList.add('hidden');
}

aboutClose.addEventListener('click', closeAboutModal);

aboutOverlay.addEventListener('click', (e) => {
  if (e.target === aboutOverlay) closeAboutModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !aboutOverlay.classList.contains('hidden')) {
    closeAboutModal();
  }
});

document.getElementById('btnAbout').addEventListener('click', openAboutModal);

// Triggered from the Help menu in main process
window.electronAPI.on('app:showAbout', openAboutModal);
