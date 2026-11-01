const { WebContentsView, ipcMain } = require('electron');
const path = require('path');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

let overlayView = null;
let overlayWin = null;

function initOverlay(win) {
  overlayWin = win;
  overlayView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(RENDERER_DIR, 'overlay-preload.js'),
    },
  });
  overlayView.setBackgroundColor('#00000000'); // transparent
  overlayView.setVisible(false);
  win.contentView.addChildView(overlayView);   // added last = on top

  overlayView.webContents.on('preload-error', (_e, p, err) =>
    console.error('[overlay] preload-error', p, err));
  overlayView.webContents.loadFile(path.join(RENDERER_DIR, 'overlay', 'index.html'));

  ipcMain.on('overlay-close', () => {
    console.log('[overlay] close message received');
    hideOverlay();
  });
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
