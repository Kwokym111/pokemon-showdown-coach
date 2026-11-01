// main.js: the MAIN process.
// This is the only part of the app that can touch Node, the file system, menus and
// windows. The web pages (Showdown, our panel) run in separate RENDERER processes
// that are sandboxed away from all of that on purpose. They can only talk to us
// through the channels we open (here: one IPC message, forwarded by panel-preload.js).

const { app, BaseWindow, WebContentsView, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const SHOWDOWN_URL = 'https://play.pokemonshowdown.com';
const PANEL_WIDTH = 360;

let win;
let showdownView;
let panelView;
let panelVisible = true;
let logDir; // <userData>/battle-logs, set once the app is ready

// ---------------------------------------------------------------------------
// Window + views (R1, R3)
// ---------------------------------------------------------------------------

function createWindow() {
  // BaseWindow is just an empty frame. The content comes from the two views below.
  win = new BaseWindow({ width: 1400, height: 900, minWidth: 700, minHeight: 400, title: 'Showdown Coach (spike)' });

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
      preload: path.join(__dirname, 'panel-preload.js'),
    },
  });

  win.contentView.addChildView(showdownView);
  win.contentView.addChildView(panelView);

  // Links that try to open a new window (target=_blank, popups) go to the user's real
  // browser instead. Only http(s) is allowed out; anything else is dropped.
  showdownView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  panelView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  logLoadProblems(showdownView.webContents, 'showdown');
  logLoadProblems(panelView.webContents, 'panel');

  // Attach the debugger BEFORE loading the page so we cannot miss the WebSocket
  // being created.
  attachBattleCapture(showdownView.webContents);

  showdownView.webContents.loadURL(SHOWDOWN_URL);
  panelView.webContents.loadFile(path.join(__dirname, 'panel.html'));

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
}

function togglePanel() {
  panelVisible = !panelVisible;
  layoutViews();
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

// ---------------------------------------------------------------------------
// Battle capture via the Chrome DevTools Protocol (R5)
// ---------------------------------------------------------------------------
// Why the debugger and not a script injected into the page: the page's own JS owns the
// WebSocket, and we do not want to modify Showdown. CDP lets us watch network frames
// from the outside.

// Turns one raw WebSocket payload into [{ room, lines }]. Pure function: no Electron,
// no files. Showdown uses SockJS framing: "a" + JSON array of message strings.
function decodeFrame(payload) {
  let messages;
  if (payload.startsWith('a[')) {
    try {
      messages = JSON.parse(payload.slice(1));
    } catch {
      messages = [payload]; // looked like SockJS but was not valid JSON: keep as plain text
    }
  } else {
    messages = [payload];
  }

  const out = [];
  for (const msg of messages) {
    if (typeof msg !== 'string') continue;
    const lines = msg.split('\n');
    // A room message starts with ">roomid". Messages without it are global (login, etc.).
    if (!lines[0].startsWith('>')) continue;
    const room = lines.shift().slice(1).trim();
    if (!room.startsWith('battle-')) continue;
    out.push({ room, lines: lines.filter((l) => l !== '') });
  }
  return out;
}

function attachBattleCapture(webContents) {
  const seenSockets = new Set();
  const seenRooms = new Set();
  let rawFramesLogged = 0;

  // Network.enable is safe to send more than once. We send it now and again once the
  // page's DOM exists, in case the first one is lost while the renderer is still starting.
  const enableNetwork = (when) => {
    if (!webContents.debugger.isAttached()) return;
    webContents.debugger.sendCommand('Network.enable').then(
      () => console.log(`[capture] Network.enable ok (${when})`),
      (err) => console.error(`[capture] Network.enable failed (${when}):`, err.message),
    );
  };

  try {
    webContents.debugger.attach('1.3');
    console.log('[capture] debugger attached to Showdown view');
    enableNetwork('at attach');
    webContents.on('dom-ready', () => enableNetwork('dom-ready'));
  } catch (err) {
    console.error('[capture] FAILED to attach debugger:', err.message);
    return;
  }

  // Fires if the debugger is kicked off, e.g. when you open DevTools on this view.
  // Not re-attached on purpose, so the failure is visible instead of hidden.
  webContents.debugger.on('detach', (_e, reason) => {
    // "target closed" is just the normal sound of the window closing; anything else
    // (e.g. "replaced with devtools") means capture really stopped mid-session.
    if (reason === 'target closed') {
      console.log('[capture] debugger detached (window closing)');
    } else {
      console.error(`[capture] debugger DETACHED (reason: ${reason}). Battle capture is now OFF until restart.`);
    }
  });

  webContents.debugger.on('message', (_e, method, params) => {
    try {
      if (method === 'Network.webSocketCreated') {
        if (!seenSockets.has(params.url)) {
          seenSockets.add(params.url);
          console.log('[capture] WebSocket created:', params.url);
        }
        return;
      }
      if (method !== 'Network.webSocketFrameReceived') return;

      const payload = params.response.payloadData;

      // Show the first few raw frames untouched so we can see the real format.
      if (rawFramesLogged < 5) {
        rawFramesLogged++;
        console.log(`[capture] raw frame #${rawFramesLogged}:`, JSON.stringify(payload.slice(0, 300)));
      }

      for (const { room, lines } of decodeFrame(payload)) {
        if (lines.length === 0) continue;
        if (!seenRooms.has(room)) {
          seenRooms.add(room);
          console.log('[capture] new battle room:', room);
        }
        writeLines(room, lines);
        sendToPanel(room, lines);
      }
    } catch (err) {
      console.error('[capture] error handling a frame:', err);
    }
  });
}

function writeLines(room, lines) {
  // The room id comes from a remote server, so never trust it as a file name:
  // strip anything except letters, digits, "-" and "_" (blocks "../" tricks).
  const safe = room.replace(/[^A-Za-z0-9_-]/g, '_');
  fs.appendFileSync(path.join(logDir, `${safe}.log`), lines.join('\n') + '\n');
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
      label: 'Spike',
      submenu: [
        {
          label: 'Toggle panel',
          // A menu accelerator only fires while this app is focused, unlike
          // globalShortcut, which would grab the keys system-wide.
          accelerator: 'CommandOrControl+Shift+K',
          click: togglePanel,
        },
        { type: 'separator' },
        // mode:'detach' because DevTools cannot dock inside a view of a BaseWindow.
        // Opening DevTools on the Showdown view will detach the capture debugger.
        { label: 'Open DevTools for Showdown view', click: () => showdownView.webContents.openDevTools({ mode: 'detach' }) },
        { label: 'Open DevTools for panel view', click: () => panelView.webContents.openDevTools({ mode: 'detach' }) },
        { type: 'separator' },
        { label: 'Print storage location', click: printStorageLocation },
        { label: 'Open battle-logs folder', click: () => shell.openPath(logDir) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  logDir = path.join(app.getPath('userData'), 'battle-logs');
  fs.mkdirSync(logDir, { recursive: true });
  console.log('[startup] battle logs folder:', logDir);

  createWindow();
  buildMenu();
});

app.on('window-all-closed', () => app.quit());
