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
  // callback receives { room }: a new battle (or a replay of one) is starting
  onReset: (callback) => {
    ipcRenderer.on('battle-reset', (_event, data) => callback(data));
  },
  // callback receives the review object (or { room, error } / { room, spectated }),
  // the same payload the popup card gets.
  onReview: (callback) => {
    ipcRenderer.on('review-ready', (_event, data) => callback(data));
  },
  // callback receives 'pending' or 'unavailable' (state of the AI explanations)
  onReviewAiStatus: (callback) => {
    ipcRenderer.on('review-ai-status', (_event, state) => callback(state));
  },
  // callback receives { room, info }. info is a plain object to show, or null meaning
  // "clear the live section" (one channel for both, so no separate reset listener).
  onLiveInfo: (callback) => {
    ipcRenderer.on('live-info', (_event, data) => callback(data));
  },
});
