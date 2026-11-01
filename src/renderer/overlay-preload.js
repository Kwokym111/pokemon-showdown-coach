   const { contextBridge, ipcRenderer } = require('electron');

   contextBridge.exposeInMainWorld('review', {
     onBattleLog: (cb) => ipcRenderer.on('battle-log', (_e, data) => cb(data)),
     close: () => ipcRenderer.send('overlay-close'),
   });