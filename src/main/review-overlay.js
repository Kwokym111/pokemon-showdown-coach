const { WebContentsView, ipcMain } = require('electron');
const path = require('path');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

let overlayView = null;
let overlayWin = null;
let overlayVisible = false; // tracked here so late AI results know whether the card is still open

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

// payload is the review object from buildReview, or { room, error: true } /
// { room, spectated: true } when there is no review to show. The page decides how to draw each.
function showOverlay(payload) {
  if (!overlayView) return;
  layoutOverlay();
  overlayWin.contentView.addChildView(overlayView); // re-adding moves it to the top
  overlayView.setVisible(true);
  overlayVisible = true;
  overlayView.webContents.send('review-ready', payload);
}

// Replaces what the open card shows (used when the AI text arrives). Does nothing if the
// user already closed the card: a late answer must not pop it back up.
function updateOverlay(payload) {
  if (!overlayView || !overlayVisible || overlayView.webContents.isDestroyed()) return;
  overlayView.webContents.send('review-ready', payload);
}

// state: 'pending' (AI text is being written) or 'unavailable' (it will not arrive).
function sendAiStatus(state) {
  if (!overlayView || !overlayVisible || overlayView.webContents.isDestroyed()) return;
  overlayView.webContents.send('ai-status', state);
}

function hideOverlay() {
  if (overlayView) overlayView.setVisible(false);
  overlayVisible = false;
}

module.exports = { initOverlay, layoutOverlay, showOverlay, updateOverlay, sendAiStatus, hideOverlay };
