// panel-preload.js: runs inside the panel's renderer, BEFORE panel.html's own scripts.
// Why it exists: the panel page is sandboxed and cannot use ipcRenderer directly. The
// preload can, so it exposes one tiny function to the page through contextBridge.
// The page never gets ipcRenderer itself, only this single-purpose listener.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panelAPI', {
  // callback receives { room, line }
  onLine: (callback) => {
    // Pass only the data, not the IPC event object, so nothing privileged leaks through.
    ipcRenderer.on('battle-line', (_event, data) => callback(data));
  },
});
