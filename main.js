'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path   = require('path');
const fs     = require('fs');
const http   = require('http');
const https  = require('https');
const { URL } = require('url');

// ─── Window ───────────────────────────────────────────────────────────────────
let mainWindow = null;

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

function stopSpeedInterval () {
  if (session && session.speedInterval) {
    clearInterval(session.speedInterval);
    session.speedInterval = null;
  }
}

// ─── Concurrency queue ────────────────────────────────────────────────────────
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

    function cleanup (deletePartial) {
      clearInterval(speedTimer);
      session.activeRequests.delete(idx);
      if (deletePartial && tmpPath) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
      }
    }

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
          size:     downloaded,
          elapsed:  Date.now() - fileStart,
        });
      }
      resolve();
    }

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

function sanitizeFilename (name) {
  return path.basename(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '_')
    .substring(0, 240) || 'unnamed_file';
}

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

// ─── IPC emit helper ──────────────────────────────────────────────────────────
function emit (channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}
