// main.js: the MAIN process.
// This is the only part of the app that can touch Node, the file system, menus and
// windows. The web pages (Showdown, our panel) run in separate RENDERER processes
// that are sandboxed away from all of that on purpose. They can only talk to us
// through the channels we open (here: one IPC message, forwarded by panel-preload.js).

const { app, BaseWindow, WebContentsView, Menu, shell } = require('electron');
const path = require('path');
const { attachBattleCapture } = require('./capture');
const { initLogs, getLogDir, readLog, writeLines } = require('./logs');
const { initOverlay, layoutOverlay, showOverlay } = require('./review-overlay');

const SHOWDOWN_URL = 'https://play.pokemonshowdown.com';
const PANEL_WIDTH = 360;
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

let win;
let showdownView;
let panelView;
let panelVisible = true;
let reloadingOnPurpose = false; // true only while our "Reload Showdown" menu item runs
// Rooms whose end-of-game card was already triggered, so later frames of the same
// battle (rating lines, |deinit|) don't pop it up a second time.
const finishedRooms = new Set();

// ---------------------------------------------------------------------------
// Window + views (R1, R3)
// ---------------------------------------------------------------------------

function createWindow() {
  // BaseWindow is just an empty frame. The content comes from the two views below.
  win = new BaseWindow({ width: 1400, height: 900, minWidth: 700, minHeight: 400, title: 'Showdown Coach' });

  // Same three security settings on every view. contextIsolation + sandbox keep a web
  // page from reaching Node; nodeIntegration:false would block require() in the page.
  const secure = { contextIsolation: true, nodeIntegration: false, sandbox: true };

  showdownView = new WebContentsView({
    webPreferences: {
      ...secure,
      // "persist:" prefix = stored on disk, so the login survives quitting the app.
      // Without the prefix the partition lives in memory and is wiped on quit.
      partition: 'persist:showdown',
    },
  });

  panelView = new WebContentsView({
    webPreferences: {
      ...secure,
      // The preload runs before the panel page, in a safe bridge context. With
      // sandbox:true it may only use a small set of Electron modules (contextBridge,
      // ipcRenderer), which is all it needs.
      preload: path.join(RENDERER_DIR, 'panel-preload.js'),
    },
  });

  win.contentView.addChildView(showdownView);
  win.contentView.addChildView(panelView);

  initOverlay(win);

  // Links that try to open a new window (target=_blank, popups) go to the user's real
  // browser instead. Only http(s) is allowed out; anything else is dropped.
  showdownView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  panelView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // While you are in a battle, Showdown's page blocks leaving ("beforeunload"). A browser
  // turns that into a prompt, but Electron silently cancels the navigation, so a reload
  // just does nothing. Calling preventDefault() here means "ignore the page's objection
  // and go ahead". Only done for our own reload, so closing the window or other
  // navigations still respect the page.
  showdownView.webContents.on('will-prevent-unload', (event) => {
    console.log(`[reload] page tried to block unload (override ${reloadingOnPurpose ? 'ON: reloading anyway' : 'OFF: staying'})`);
    if (reloadingOnPurpose) event.preventDefault();
  });

  logLoadProblems(showdownView.webContents, 'showdown');
  logLoadProblems(panelView.webContents, 'panel');

  // Attach the debugger BEFORE loading the page so we cannot miss the WebSocket
  // being created.
  attachBattleCapture(showdownView.webContents, (room, lines) => {
    const { fresh } = writeLines(room, lines);
    // A fresh log means a new battle or a replay of one, so the panel must drop what it
    // is showing before the new lines arrive.
    if (fresh) {
      sendResetToPanel(room);
      // Same idea for the card: joining the room again (e.g. re-watching a finished
      // battle) replays its |win| line, and that should be allowed to show the card again.
      finishedRooms.delete(room);
    }
    sendToPanel(room, lines);

    if (!finishedRooms.has(room) && lines.some((l) => /^\|(win|tie)\b/.test(l))) {
      finishedRooms.add(room);
      console.log('[capture] game finished in', room);
      setTimeout(() => showOverlayForRoom(room), 400);
    }
  });

  showdownView.webContents.loadURL(SHOWDOWN_URL);
  panelView.webContents.loadFile(path.join(RENDERER_DIR, 'panel.html'));

  // Re-layout whenever the window size or state changes.
  for (const evt of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(evt, layoutViews);
  }
  layoutViews();
}

// All layout math lives here. Views are positioned in the window's content area,
// so we only need its width and height (not its position on the screen).
function layoutViews() {
  if (!win || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();

  const panelWidth = panelVisible ? Math.min(PANEL_WIDTH, width) : 0;
  const showdownWidth = width - panelWidth;

  showdownView.setBounds({ x: 0, y: 0, width: showdownWidth, height });
  panelView.setBounds({ x: showdownWidth, y: 0, width: panelWidth, height });
  panelView.setVisible(panelVisible);

  layoutOverlay();
}

function togglePanel() {
  panelVisible = !panelVisible;
  layoutViews();
}

let reloadFlagTimer;
function reloadShowdown() {
  console.log('[reload] Reload Showdown requested');
  reloadingOnPurpose = true;
  // Switch the flag off after a moment instead of on the first "did-start-loading": I
  // could not rely on that event firing AFTER the page's unload check, and if it fires
  // first the override is gone and the reload is silently blocked again.
  clearTimeout(reloadFlagTimer);
  reloadFlagTimer = setTimeout(() => { reloadingOnPurpose = false; }, 3000);
  showdownView.webContents.reload();
}

// R1: make a blank page diagnosable by printing why it failed.
function logLoadProblems(webContents, name) {
  webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error(`[${name}] did-fail-load code=${errorCode} (${errorDescription}) url=${validatedURL} mainFrame=${isMainFrame}`);
  });
  webContents.on('render-process-gone', (_e, details) => {
    console.error(`[${name}] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
  });
}

function sendResetToPanel(room) {
  if (!panelView || panelView.webContents.isDestroyed()) return;
  panelView.webContents.send('battle-reset', { room });
}

// Reads the finished battle's log and hands it to the end-of-game card.
function showOverlayForRoom(room) {
  const text = readLog(room);
  if (text === null) {
    console.error('[overlay] could not read log for', room);
    return;
  }
  // |request| lines only reach the two players, so no |request| means we were only
  // spectating this battle: there is nothing of ours to review.
  if (!text.includes('|request|')) {
    console.log('[overlay] no |request| in', room, '(spectated?), skipping');
    return;
  }
  console.log('[overlay] showing for', room);
  showOverlay(room, text);
}

// One IPC message per line. panel-preload.js receives it and hands it to the page.
function sendToPanel(room, lines) {
  if (!panelView || panelView.webContents.isDestroyed()) return;
  for (const line of lines) {
    panelView.webContents.send('battle-line', { room, line });
  }
}

// ---------------------------------------------------------------------------
// Menu (R4, R6)
// ---------------------------------------------------------------------------

function printStorageLocation() {
  const ses = showdownView.webContents.session;
  console.log('[storage] Showdown session data (persist:showdown):', ses.getStoragePath());
  console.log('[storage] App userData:', app.getPath('userData'));
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    // Replacing the menu removes the default Edit shortcuts (copy/paste), which you
    // need when typing a password into Showdown, so add the standard Edit menu back.
    { role: 'editMenu' },
    {
      label: 'Dev',
      submenu: [
        {
          label: 'Toggle panel',
          // A menu accelerator only fires while this app is focused, unlike
          // globalShortcut, which would grab the keys system-wide.
          accelerator: 'CommandOrControl+Shift+K',
          click: togglePanel,
        },
        {
          // Custom menu removed the default reload shortcut, and role:'reload' would
          // target the focused window's main web contents, not our WebContentsView.
          // Note: reloading makes Showdown replay the room history, which is why task 2
          // (fresh log file on |init|battle) matters.
          label: 'Reload Showdown',
          accelerator: 'CommandOrControl+R',
          click: reloadShowdown,
        },
        { type: 'separator' },
        // mode:'detach' because DevTools cannot dock inside a view of a BaseWindow.
        // Opening DevTools on the Showdown view will detach the capture debugger.
        { label: 'Open DevTools for Showdown view', click: () => showdownView.webContents.openDevTools({ mode: 'detach' }) },
        { label: 'Open DevTools for panel view', click: () => panelView.webContents.openDevTools({ mode: 'detach' }) },
        { type: 'separator' },
        { label: 'Print storage location', click: printStorageLocation },
        { label: 'Open battle-logs folder', click: () => shell.openPath(getLogDir()) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  console.log('[startup] battle logs folder:', initLogs(app.getPath('userData')));

  createWindow();
  buildMenu();
});

app.on('window-all-closed', () => app.quit());
