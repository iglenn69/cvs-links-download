'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_RECEIVE = [
  'file:queued',
  'file:started',
  'file:progress',
  'file:done',
  'file:failed',
  'downloads:tick',
  'downloads:done',
  'downloads:cancelled',
  'app:showAbout',
];

contextBridge.exposeInMainWorld('electronAPI', {
  // Dialogs
  openCSV:    ()          => ipcRenderer.invoke('dialog:openCSV'),
  openFolder: ()          => ipcRenderer.invoke('dialog:openFolder'),
  parseCSV:   (filePath)  => ipcRenderer.invoke('file:parseCSV', filePath),

  // Download control
  startDownloads:  (opts) => ipcRenderer.send('downloads:start',  opts),
  cancelDownloads: ()     => ipcRenderer.send('downloads:cancel'),

  // Shell helpers
  showInFolder: (filePath) => ipcRenderer.invoke('shell:showInFolder', filePath),

  // App info
  getVersionInfo: () => ipcRenderer.invoke('app:getVersionInfo'),

  // Event subscription – returns an unsubscribe function
  on (channel, callback) {
    if (!ALLOWED_RECEIVE.includes(channel)) return () => {};
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  removeAllListeners (channel) {
    if (ALLOWED_RECEIVE.includes(channel)) ipcRenderer.removeAllListeners(channel);
  },
});
