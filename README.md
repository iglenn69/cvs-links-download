# CVS Links Downloader

A desktop app built with [Electron](https://www.electronjs.org/) for batch-downloading files from a CSV/text list of URLs. Features a live speed chart, per-file progress tracking, and concurrent download control.

![Dark neutral UI with progress ring and speed chart](https://placehold.co/900x500/111113/4f8eff?text=CVS+Links+Downloader)

---

## Features

- **CSV / text file input** — one URL per line, or multi-column CSV (first field matching `http(s)://` is used)
- **Folder picker** — choose any local destination folder
- **Concurrent downloads** — 1–16 parallel workers, adjustable live via slider
- **Live speed chart** — 60-second rolling history, auto-scaling Y axis, smooth bezier curve
- **Overall progress ring** — animated SVG ring with percentage and file count
- **Stats dashboard** — Completed, Failed, Active, Queued, Downloaded bytes, Total (known), Elapsed, ETA
- **Per-file rows** — pulsing dot on active downloads, shimmer progress bar, speed, size, and status text
- **Filter tabs** — view All / Active / Done / Failed / Queued files
- **Redirect following** — up to 10 hops, HTTP and HTTPS
- **Safe filenames** — extracted from URL path or `Content-Disposition`, sanitized against path traversal, de-duplicated automatically
- **Retry Failed** — re-queues only failed items after a session completes
- **New Session** — full reset while keeping the CSV and folder paths

---

## Requirements

- [Node.js](https://nodejs.org/) 18 or later (LTS recommended)
- Windows 10 / 11 (also works on macOS and Linux)

---

## Getting Started

```bash
# 1. Clone or download this repository
cd cvs-links-download

# 2. Install dependencies
npm install

# 3. Launch the app
npm start
```

---

## CSV Format

The app accepts any plain-text file where each line contains one URL.  
Multi-column CSV rows are also supported — the first field that starts with `http://` or `https://` is used.

```
# Plain list (one URL per line)
https://example.com/file1.tif
https://example.com/file2.tif

# CSV with extra columns (first URL field is picked)
name,url,description
item1,https://example.com/file1.tif,Some label
item2,https://example.com/file2.tif,Another label
```

> **Tip:** The included `ch.swisstopo.swissalti3D_matterhorn.csv` is a ready-to-use example containing Swiss terrain model tiles.

---

## Project Structure

```
cvs-links-download/
├── main.js          # Electron main process — window, dialogs, download engine
├── preload.js       # Context-bridge IPC (secure, whitelisted channels only)
├── index.html       # App shell and UI layout
├── styles.css       # Dark neutral design theme
├── renderer.js      # UI logic, Canvas speed chart, RAF-batched DOM updates
├── package.json
└── README.md
```

---

## How It Works

```
Renderer (renderer.js)
  │  clicks "Browse" / "Start"
  ▼
preload.js  ── contextBridge ──►  main.js
                                    │
                                    ├─ dialog.showOpenDialog  (file / folder)
                                    ├─ fs.readFileSync        (parse CSV)
                                    └─ http/https.get         (download files)
                                         │  streams to disk
                                         └─ IPC events ──► renderer
                                              file:queued / started / progress
                                              file:done / failed
                                              downloads:tick / done / cancelled
```

---

## Security Notes

- `contextIsolation: true` and `nodeIntegration: false` — the renderer has no direct Node.js access
- All IPC channels are whitelisted in `preload.js`
- Downloaded filenames are sanitized to prevent path traversal (`../`, invalid characters)
- Only `http:` and `https:` protocols are accepted; others are rejected with an error

---

## License

MIT
