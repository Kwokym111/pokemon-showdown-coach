// replay-preload.js: runs inside the replay window, BEFORE replay.html's scripts.
// Exposes one single-purpose function; the page never gets ipcRenderer itself.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('replayAPI', {
  // Synchronous on purpose: Showdown's player reads the log at window "load", so the log
  // must already be in the page by then. An async reply could arrive too late. The data
  // is local and a few KB, so blocking for a moment is harmless.
  getLog: () => ipcRenderer.sendSync('replay-get-log'),
  // "Back to Showdown". Fire-and-forget; main only accepts it from this page's own view.
  close: () => ipcRenderer.send('replay-close'),
  // callback receives a turn number to show. The page (not this preload) calls Showdown's
  // seekTurn, because the player's objects live in the page's world, which the preload can't see.
  onGotoTurn: (callback) => {
    ipcRenderer.on('replay-goto-turn', (_event, turn) => callback(turn));
  },
});
