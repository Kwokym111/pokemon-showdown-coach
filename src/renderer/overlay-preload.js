// Bridge for the end-of-game card: exposes only "receive the review", "receive the AI
// status" and "close".
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('review', {
  onReview: (cb) => ipcRenderer.on('review-ready', (_e, data) => cb(data)),
  onAiStatus: (cb) => ipcRenderer.on('ai-status', (_e, state) => cb(state)),
  close: () => ipcRenderer.send('overlay-close'),
});
