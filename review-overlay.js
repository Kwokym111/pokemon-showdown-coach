const { WebContentsView, ipcMain } = require('electron');
const path = require('path');

let overlayView = null;
let overlayWin = null;

function initOverlay(win) {
  overlayWin = win;
  overlayView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'overlay-preload.js'),
    },
  });
  overlayView.setBackgroundColor('#00000000'); // transparent
  overlayView.setVisible(false);
  win.contentView.addChildView(overlayView);   // added last = on top
  overlayView.webContents.loadFile(path.join(__dirname, 'overlay', 'index.html'));
  ipcMain.on('overlay-close', hideOverlay);
  layoutOverlay();
}

function layoutOverlay() {
  if (!overlayView || !overlayWin || overlayWin.isDestroyed()) return;
  const { width, height } = overlayWin.getContentBounds();
  overlayView.setBounds({ x: 0, y: 0, width, height });
}

function showOverlay(room, log) {
  if (!overlayView) return;
  layoutOverlay();
  overlayWin.contentView.addChildView(overlayView); // re-adding moves it to the top
  overlayView.setVisible(true);
  overlayView.webContents.send('battle-log', { room, log });
}

function hideOverlay() {
  if (overlayView) overlayView.setVisible(false);
}

module.exports = { initOverlay, layoutOverlay, showOverlay, hideOverlay };