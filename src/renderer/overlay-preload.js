// Bridge for the end-of-game card: exposes only "receive the battle log" and "close".
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('review', {
  onBattleLog: (cb) => ipcRenderer.on('battle-log', (_e, data) => cb(data)),
  close: () => ipcRenderer.send('overlay-close'),
});
