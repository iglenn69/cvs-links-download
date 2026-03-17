'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path   = require('path');
const fs     = require('fs');
const http   = require('http');
const https  = require('https');
const { URL } = require('url');

// ─── Window ───────────────────────────────────────────────────────────────────
let mainWindow = null;

/**
 * Creates the main Electron BrowserWindow, loads index.html into it, and
 * registers a listener to null out the reference when the window is closed.
 */
function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 660,
    backgroundColor: '#111113',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ─── Session state ────────────────────────────────────────────────────────────
let session = null;   // active download session descriptor

// ─── IPC: dialogs & file parsing ─────────────────────────────────────────────
ipcMain.handle('dialog:openCSV', async () => {
  if (!mainWindow) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select CSV / Link List',
    properties: ['openFile'],
    filters: [
      { name: 'Link lists', extensions: ['csv', 'txt', 'lst'] },
      { name: 'All Files',  extensions: ['*'] },
    ],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('dialog:openFolder', async () => {
  if (!mainWindow) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Destination Folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('file:parseCSV', async (_e, filePath) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const urls = raw
      .split(/\r?\n/)
      .map(line => {
        // Handle plain URL or a CSV row – grab first field that looks like a URL
        const fields = line.split(',').map(f => f.replace(/^["'\s]+|["'\s]+$/g, ''));
        return fields.find(f => /^https?:\/\//i.test(f)) || null;
      })
      .filter(Boolean);
    return { ok: true, urls, count: urls.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ─── IPC: download control ────────────────────────────────────────────────────
ipcMain.on('downloads:start', (_e, { urls, destFolder, concurrency }) => {
  if (session && session.running) return;

  session = {
    running:         true,
    cancelled:       false,
    total:           urls.length,
    completed:       0,
    failed:          0,
    totalBytes:      0,
    downloadedBytes: 0,
    startTime:       Date.now(),
    activeRequests:  new Map(),   // idx → req
    usedFilenames:   new Set(),
    speedInterval:   null,
    bytesWindow:     0,
    windowStart:     Date.now(),
  };

  const conc = Math.max(1, Math.min(concurrency || 4, 16));
  startSpeedInterval();
  processQueue(urls, destFolder, conc);
});

ipcMain.on('downloads:cancel', () => {
  if (!session || !session.running) return;
  session.cancelled = true;
  session.running   = false;
  stopSpeedInterval();
  for (const req of session.activeRequests.values()) {
    try { req.destroy(); } catch (_) {}
  }
  session.activeRequests.clear();
  emit('downloads:cancelled', {});
});

// ─── Speed pulse interval (1 s) ───────────────────────────────────────────────

/**
 * Starts a 1-second recurring interval that calculates the rolling download
 * speed for the current measurement window, computes an ETA, and broadcasts
 * a `downloads:tick` event to the renderer with the full session snapshot.
 * Any previously running interval is stopped first to prevent duplicates.
 */
function startSpeedInterval () {
  stopSpeedInterval();
  session.speedInterval = setInterval(() => {
    if (!session) return;
    const now = Date.now();
    const dt  = (now - session.windowStart) / 1000;
    const spd = dt > 0 ? session.bytesWindow / dt : 0;
    session.bytesWindow  = 0;
    session.windowStart  = now;

    const elapsed = now - session.startTime;
    const active  = session.activeRequests.size;
    const queued  = session.total - session.completed - session.failed - active;
    const eta = spd > 0 && session.totalBytes > session.downloadedBytes
      ? (session.totalBytes - session.downloadedBytes) / spd
      : null;

    emit('downloads:tick', {
      speed:          spd,
      elapsed,
      completed:      session.completed,
      failed:         session.failed,
      active,
      queued:         Math.max(0, queued),
      total:          session.total,
      downloadedBytes: session.downloadedBytes,
      totalBytes:     session.totalBytes,
      eta,
    });
  }, 1000);
}

/**
 * Clears the active speed-pulse interval and resets the session reference
 * to `null`, preventing further `downloads:tick` events from being emitted.
 */
function stopSpeedInterval () {
  if (session && session.speedInterval) {
    clearInterval(session.speedInterval);
    session.speedInterval = null;
  }
}

// ─── Concurrency queue ────────────────────────────────────────────────────────
/**
 * Processes the full list of URLs using a concurrent worker-pool pattern.
 * Creates up to `concurrency` workers (capped at the total number of URLs),
 * each of which drains the shared queue sequentially. Workers stop early if
 * the session is cancelled. Once all workers settle, emits `downloads:done`
 * with final totals (unless the session was cancelled).
 *
 * @param {string[]} urls        - Array of URLs to download.
 * @param {string}   destFolder  - Absolute path to the destination directory.
 * @param {number}   concurrency - Maximum number of simultaneous downloads.
 */
async function processQueue (urls, destFolder, concurrency) {
  const queue = urls.map((url, idx) => ({ url, idx }));
  const total = queue.length;

  async function worker () {
    while (queue.length > 0 && !session.cancelled) {
      const task = queue.shift();
      if (!task) break;
      emit('file:queued', { idx: task.idx, url: task.url });
      await downloadOne(task.idx, task.url, destFolder);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, total) }, worker);
  await Promise.all(workers);

  if (!session.cancelled) {
    stopSpeedInterval();
    session.running = false;
    emit('downloads:done', {
      total:     session.total,
      completed: session.completed,
      failed:    session.failed,
      elapsed:   Date.now() - session.startTime,
    });
  }
}

// ─── Single-file download ─────────────────────────────────────────────────────
/**
 * Downloads a single file identified by `url` to `destFolder`, following up
 * to 10 HTTP redirects. Emits granular progress events (`file:started`,
 * `file:progress`, `file:done`, `file:failed`) throughout the lifecycle.
 * Returns a Promise that resolves (never rejects) when the download finishes,
 * errors, or is cancelled.
 *
 * @param {number} idx        - Zero-based index of this file in the session, used
 *                              to correlate renderer UI rows with download tasks.
 * @param {string} url        - The URL to download.
 * @param {string} destFolder - Absolute path to the destination directory.
 * @returns {Promise<void>}
 */
function downloadOne (idx, url, destFolder) {
  return new Promise(resolve => {
    if (session.cancelled) return resolve();

    const fileStart = Date.now();
    let downloaded  = 0;
    let fileTotal   = 0;
    let lastBytes   = 0;
    let lastTime    = fileStart;
    let speedTimer  = null;
    let tmpPath     = null;
    let fileStream  = null;

    /**
     * Stops the per-file speed timer, removes the active request from the
     * session map, and optionally deletes a partially written temp file.
     *
     * @param {boolean} deletePartial - When `true`, unlinks the partial file on disk.
     */
    function cleanup (deletePartial) {
      clearInterval(speedTimer);
      session.activeRequests.delete(idx);
      if (deletePartial && tmpPath) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
      }
    }

    /**
     * Finalises the download attempt. On success, increments the completed
     * counter and emits `file:done`. On error, increments the failed counter
     * and emits `file:failed`. Either way, resolves the outer Promise so the
     * worker can proceed to the next task. Silently discards the result if the
     * session has been cancelled in the interim.
     *
     * @param {Error|null} err - The error that occurred, or `null` on success.
     */
    function finish (err) {
      // If the session was cancelled, cleanly discard without marking as failed
      if (session.cancelled) {
        cleanup(true);
        return resolve();
      }
      if (err) {
        cleanup(true);
        session.failed++;
        emit('file:failed', { idx, url, error: err.message });
      } else {
        cleanup(false);
        session.completed++;
        emit('file:done', {
          idx,
          filename: path.basename(tmpPath || ''),
          filePath: tmpPath || '',
          size:     downloaded,
          elapsed:  Date.now() - fileStart,
        });
      }
      resolve();
    }

    /**
     * Performs the HTTP/HTTPS GET request for the given URL, handling redirects
     * recursively up to a maximum depth of 10. On a successful 2xx response,
     * pipes the body to a write stream and drips per-chunk byte counts into
     * the session's speed-window accumulators. Enforces a 30-second connection
     * timeout and registers the request in `session.activeRequests` so it can
     * be destroyed on cancellation.
     *
     * @param {string} rawUrl    - The URL to request (may change after redirects).
     * @param {number} redirects - How many redirects have been followed so far.
     */
    function doRequest (rawUrl, redirects) {
      if (redirects > 10) return finish(new Error('Too many redirects'));
      if (session.cancelled)  return resolve();

      let parsedUrl;
      try { parsedUrl = new URL(rawUrl); }
      catch { return finish(new Error('Invalid URL')); }

      if (!['http:', 'https:'].includes(parsedUrl.protocol))
        return finish(new Error(`Unsupported protocol: ${parsedUrl.protocol}`));

      const lib = parsedUrl.protocol === 'https:' ? https : http;
      const req = lib.get(rawUrl, { headers: { 'User-Agent': 'CVSLinksDownloader/1.0' } }, res => {
        // Follow redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const loc = res.headers['location'];
          if (!loc) return finish(new Error(`Redirect ${res.statusCode} without Location`));
          res.resume();
          return doRequest(new URL(loc, rawUrl).toString(), redirects + 1);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return finish(new Error(`HTTP ${res.statusCode} ${res.statusMessage}`));
        }

        const contentLength = parseInt(res.headers['content-length'] || '0', 10) || 0;
        fileTotal = contentLength;
        session.totalBytes += contentLength;

        const rawName  = extractFilename(rawUrl, res.headers['content-disposition'] || '', res.headers['content-type'] || '', idx);
        const filename = getUniqueFilename(destFolder, rawName);
        tmpPath        = path.join(destFolder, filename);

        emit('file:started', { idx, url: rawUrl, filename, contentLength });

        try {
          fileStream = fs.createWriteStream(tmpPath);
        } catch (err) {
          res.resume();
          return finish(err);
        }

        speedTimer = setInterval(() => {
          const now = Date.now();
          const dt  = (now - lastTime) / 1000;
          const spd = dt > 0 ? (downloaded - lastBytes) / dt : 0;
          lastTime  = now;
          lastBytes = downloaded;
          emit('file:progress', { idx, downloaded, total: fileTotal, speed: spd });
        }, 400);

        res.on('data', chunk => {
          downloaded          += chunk.length;
          session.downloadedBytes += chunk.length;
          session.bytesWindow     += chunk.length;
        });
        res.pipe(fileStream);
        fileStream.on('finish', () => finish(null));
        fileStream.on('error',  err  => finish(err));
        res.on('error',         err  => { fileStream && fileStream.destroy(); finish(err); });
      });

      req.setTimeout(30_000, () => req.destroy(new Error('Connection timeout')));
      req.on('error', err => finish(err));
      session.activeRequests.set(idx, req);
    }

    doRequest(url, 0);
  });
}

// ─── Filename helpers ─────────────────────────────────────────────────────────
/**
 * Derives a safe filename for a download from (in priority order):
 *   1. The `Content-Disposition` response header.
 *   2. The last path segment of the URL (when it contains an extension).
 *   3. A MIME-type-to-extension mapping on the `Content-Type` header.
 *   4. A generic fallback `file_<n>.bin`.
 *
 * @param {string} rawUrl      - The resolved download URL.
 * @param {string} contentDisp - Value of the `Content-Disposition` header, or `''`.
 * @param {string} contentType - Value of the `Content-Type` header, or `''`.
 * @param {number} idx         - Zero-based file index, used for the fallback name.
 * @returns {string} A sanitized filename string (no path separators).
 */
function extractFilename (rawUrl, contentDisp, contentType, idx) {
  if (contentDisp) {
    const m = contentDisp.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
    if (m) {
      const name = decodeURIComponent(m[1].trim().replace(/["']/g, ''));
      if (name) return sanitizeFilename(name);
    }
  }
  try {
    const base = path.basename(new URL(rawUrl).pathname);
    if (base && base !== '/' && /\.\w+$/.test(base)) return sanitizeFilename(base);
  } catch (_) {}

  const extMap = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/tiff': '.tif', 'image/webp': '.webp', 'image/bmp': '.bmp',
    'application/zip': '.zip', 'application/x-tar': '.tar.gz',
    'application/octet-stream': '.bin',
  };
  const mime = contentType.split(';')[0].trim();
  return `file_${idx + 1}${extMap[mime] || '.bin'}`;
}

/**
 * Strips or replaces characters that are illegal in Windows/POSIX filenames,
 * removes leading dots, and truncates to 240 characters.
 *
 * @param {string} name - Raw filename to sanitize.
 * @returns {string} A filesystem-safe filename, defaulting to `'unnamed_file'`.
 */
function sanitizeFilename (name) {
  return path.basename(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '_')
    .substring(0, 240) || 'unnamed_file';
}

/**
 * Ensures the proposed `filename` does not collide with any file already
 * written in this session or present on disk. Appends `_(n)` before the
 * extension and increments `n` until a unique candidate is found, then
 * records the chosen name in `session.usedFilenames`.
 *
 * @param {string} destFolder - Absolute path to the destination directory.
 * @param {string} filename   - Desired filename (basename only).
 * @returns {string} A unique filename safe to write without overwriting anything.
 */
function getUniqueFilename (destFolder, filename) {
  const ext  = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = filename;
  let n = 1;
  while (session.usedFilenames.has(candidate) || fs.existsSync(path.join(destFolder, candidate))) {
    candidate = `${base}_(${n++})${ext}`;
  }
  session.usedFilenames.add(candidate);
  return candidate;
}

// ─── IPC: shell helpers ──────────────────────────────────────────────────────
ipcMain.handle('shell:showInFolder', (_e, filePath) => {
  shell.showItemInFolder(filePath);
});

// ─── IPC emit helper ──────────────────────────────────────────────────────────
/**
 * Safely sends an IPC message to the renderer process. No-ops if the main
 * window no longer exists or has been destroyed.
 *
 * @param {string} channel - The IPC channel name (e.g. `'downloads:tick'`).
 * @param {object} data    - The payload object to send.
 */
function emit (channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}
