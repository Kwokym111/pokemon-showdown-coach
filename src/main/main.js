// main.js: the MAIN process.
// This is the only part of the app that can touch Node, the file system, menus and
// windows. The web pages (Showdown, our panel) run in separate RENDERER processes
// that are sandboxed away from all of that on purpose. They can only talk to us
// through the channels we open (here: one IPC message, forwarded by panel-preload.js).

const { app, BaseWindow, WebContentsView, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const { attachBattleCapture } = require('./capture');
const { initLogs, getLogDir, readLog, readLogFile, readReviewCache, writeReviewCache, writeLines } = require('./logs');
// Renamed on import: showOverlay / updateOverlay / sendAiStatus are defined again below as
// wrappers that feed the popup card AND the panel's review section, so every existing call
// site in this file updates both without being touched.
const {
  initOverlay, layoutOverlay,
  showOverlay: showCard, updateOverlay: updateCard, sendAiStatus: sendCardStatus,
} = require('./review-overlay');
const { addExplanations } = require('./ai');
const { loadAiConfig, aiIsConfigured } = require('./ai-config');
const liveInfo = require('./live-info');
const { watchReplayStart } = require('./replay-watch');
const { buildBattle } = require('../core/state');
const { buildReview } = require('../core/review');
const { applyCachedExplanations } = require('../core/review-cache');
const { cardExtras } = require('../core/card-extras');

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
let aiToken = 0; // bumped for every card shown, so only the newest card may receive AI text
let replayView = null; // the view playing a past game (in the Showdown area), or null
let replayWatcher = null; // start-check/retry for that view (see replay-watch.js)
let replayLog = ''; // log text for that view; its page fetches it via 'replay-get-log'

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
      // A live battle just started (|init|battle): leave any replay so the player never
      // plays blind. Showdown was only hidden, so this just shows it again.
      closeReplay();
      sendResetToPanel(room);
      // Same idea for the card: joining the room again (e.g. re-watching a finished
      // battle) replays its |win| line, and that should be allowed to show the card again.
      finishedRooms.delete(room);
    }
    sendToPanel(room, lines);
    // Live panel info. Wrapped so a bug there can never stop log writing or the review card.
    try {
      sendLiveInfoToPanel(room, liveInfo.handleLines(room, lines, { fresh }));
    } catch (err) {
      console.error('[live-info] could not update the live panel:', err.message);
    }

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
  // The replay takes exactly the Showdown area. Showdown keeps its bounds too (it is only
  // hidden), so switching back needs no extra layout.
  if (replayView) replayView.setBounds({ x: 0, y: 0, width: showdownWidth, height });
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

// The one path from "log text" to "card on screen", used both when a real battle ends and
// by the Dev menu's "Open review for a log file…", so the two can never drift apart.
// Never throws: a strange log must not crash the app, it just gets an error card.
function showReviewFromText(room, text, { silentIfSpectated }) {
  // Every new card invalidates any AI answer still on its way for an older one, even if
  // this card never asks the AI (spectated, error, cached): the late answer must not replace it.
  const myToken = ++aiToken;
  // |request| lines only reach the two players, so no |request| means we were only
  // spectating this battle: there is nothing of ours to review.
  if (!text.includes('|request|')) {
    console.log('[overlay] no |request| in', room, '(spectated?)');
    if (!silentIfSpectated) showOverlay({ room, spectated: true });
    return;
  }
  try {
    // The damage calc is synchronous and runs on this process, so measure how long the
    // whole build blocks the app.
    const started = Date.now();
    const lines = text.split(/\r?\n/);
    const battle = buildBattle(lines);
    const review = buildReview(battle, { room });
    Object.assign(review, cardExtras(battle, lines));
    console.log(`[review] built ${room} in ${Date.now() - started} ms (${review.moments.length} moments)`);

    // Only the AI text is cached, never the review itself: the rules may have changed since.
    const cached = applyCachedExplanations(review, readReviewCache(room));
    if (cached) {
      console.log('[ai] using the saved explanations for', room);
      showOverlay(cached);
      return;
    }
    showOverlay(review);
    explainInBackground(room, review, myToken);
  } catch (err) {
    console.error('[review] could not build the review for', room, err);
    showOverlay({ room, error: true });
  }
}

// Asks the AI for the words while the card is already on screen. Never throws.
async function explainInBackground(room, review, myToken) {
  // Nothing to explain: a summary of "the game ended" is not worth a call and a wait.
  if (review.moments.length === 0) return;

  const config = loadAiConfig();
  if (!aiIsConfigured(config)) {
    console.log('[ai] no AI provider configured in .env, showing the review without AI text');
    sendAiStatus('unavailable');
    return;
  }

  sendAiStatus('pending');
  const started = Date.now();
  const explained = await addExplanations(review, config);
  console.log(`[ai] ${explained.aiUsed ? 'explained' : 'could not explain'} ${room} in ${Date.now() - started} ms`);

  if (explained.aiUsed) writeReviewCache(room, explained); // failures are not saved, so the next open retries
  if (myToken !== aiToken) return;
  if (explained.aiUsed) updateOverlay(explained);
  else sendAiStatus('unavailable');
}

// End of a real battle: read what capture saved, then show the card. Spectated games are
// skipped silently here (nothing popped up before either).
function showOverlayForRoom(room) {
  const text = readLog(room);
  if (text === null) {
    console.error('[overlay] could not read log for', room);
    return;
  }
  showReviewFromText(room, text, { silentIfSpectated: true });
}

// Review a saved log without playing a battle. Shared by the Dev menu (starts in test-data/)
// and Games > Past games… (starts in the real battle-logs folder): the only difference
// between the two is where the picker opens, so they pass title/defaultPath instead of
// duplicating the function. The dialog falls back to a default folder if the path is missing.
async function openReviewForLogFile({
  title = 'Open review for a log file',
  defaultPath = path.join(__dirname, '..', '..', 'test-data'),
  withReplay = false, // also play the replay in the main window (Past games only)
} = {}) {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title,
    defaultPath,
    filters: [{ name: 'Battle logs', extensions: ['log'] }],
    properties: ['openFile'],
  });
  if (canceled || filePaths.length === 0) return;

  const file = filePaths[0];
  const room = path.basename(file, '.log');
  const text = readLogFile(file);
  if (text === null) {
    console.error('[overlay] could not read', file);
    showOverlay({ room, error: true });
    return;
  }
  showReviewFromText(room, text, { silentIfSpectated: false });
  if (withReplay) openReplay(room, text);
}

// ---------------------------------------------------------------------------
// Replay view: Showdown's own replay player, fed with our captured log, shown in the
// Showdown area of the main window. The Showdown view is only HIDDEN meanwhile (never
// destroyed or reloaded), so its login, socket and the live capture keep running.
// ---------------------------------------------------------------------------

// Throws nothing: the review must keep working even if the replay cannot open.
function openReplay(room, text) {
  try {
    // One replay at a time: opening another game replaces the old one.
    removeReplayView();

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // No "persist:" prefix = in memory only, and a different partition from
        // persist:showdown, so the remote player scripts never see the Showdown login cookies.
        partition: 'replay',
        preload: path.join(RENDERER_DIR, 'replay-preload.js'),
      },
    });
    replayView = view;
    replayLog = text;

    const wc = view.webContents;
    // Links in the battle chat go to the real browser; the page itself never navigates away.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e) => e.preventDefault());
    logLoadProblems(wc, 'replay');
    // Debug aid: shows CSP blocks and script errors from the player in the terminal.
    wc.on('console-message', (e) => {
      // The player also asks for ~20 effect images by a bare relative name (wisp.png...), which
      // resolve to our local folder and fail; the real replay site 404s on them too. Skip that noise.
      if (/Loading the image 'file:/.test(e.message)) return;
      // sourceId/lineNumber say WHICH script broke (e.g. a "$ is not defined" culprit).
      if (e.level === 'warning' || e.level === 'error') {
        console.log(`[replay] page ${e.level}: ${e.message} (${e.sourceId}:${e.lineNumber})`);
      }
    });

    // Safety net: if the player has not started a few seconds after load, reload once.
    replayWatcher = watchReplayStart(wc, {
      onEvent: (type, detail) => console.log(`[replay] start check: ${type}`, JSON.stringify(detail)),
    });

    // Index 0 = bottom of the stack. Views added later are drawn on top, and the popup card
    // and the panel must always stay above the replay. Showdown is hidden meanwhile, so being
    // below it does not matter.
    win.contentView.addChildView(view, 0);
    showdownView.setVisible(false);
    layoutViews(); // gives the replay exactly the Showdown area

    wc.loadFile(path.join(RENDERER_DIR, 'replay.html'));
  } catch (err) {
    console.error('[replay] could not open the replay:', err);
    closeReplay(); // never leave Showdown hidden behind a half-made replay
  }
}

// Takes the replay view out of the window and frees its page. Does NOT touch Showdown, so
// openReplay can use it to swap one replay for another without flashing Showdown in between.
function removeReplayView() {
  if (replayWatcher) { replayWatcher.stop(); replayWatcher = null; }
  const view = replayView;
  replayView = null;
  replayLog = '';
  if (!view) return;
  try {
    if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
    // A removed view keeps its page alive (and playing) until the page is closed explicitly.
    if (!view.webContents.isDestroyed()) view.webContents.close();
  } catch (err) {
    console.error('[replay] could not remove the old replay view:', err);
  }
}

// The way back: drop the replay and show Showdown again. Safe to call when no replay is open.
function closeReplay() {
  removeReplayView();
  if (showdownView && !showdownView.webContents.isDestroyed()) showdownView.setVisible(true);
  layoutViews();
}

// The replay page asks for its log here. Answer only the view we created, so no other
// page can read battle logs through this channel.
ipcMain.on('replay-get-log', (event) => {
  const ok = replayView && !replayView.webContents.isDestroyed() && event.sender === replayView.webContents;
  event.returnValue = ok ? replayLog : '';
});

// A review moment was clicked in the panel: show that turn in the replay. Only the panel may
// ask, and the value is checked here because it comes from a page. No replay open = nothing.
ipcMain.on('goto-turn', (event, turn) => {
  if (!panelView || event.sender !== panelView.webContents) return;
  if (!Number.isInteger(turn) || turn < 0 || turn > 10000) return;
  if (!replayView || replayView.webContents.isDestroyed()) return;
  replayView.webContents.send('replay-goto-turn', turn);
});

// The "Back to Showdown" button in the replay page. Same rule: only the replay view may ask.
ipcMain.on('replay-close', (event) => {
  if (replayView && !replayView.webContents.isDestroyed() && event.sender === replayView.webContents) closeReplay();
});

// One IPC message per line. panel-preload.js receives it and hands it to the page.
function sendToPanel(room, lines) {
  if (!panelView || panelView.webContents.isDestroyed()) return;
  for (const line of lines) {
    panelView.webContents.send('battle-line', { room, line });
  }
}

// The panel's review section gets the same payloads as the popup card. Unlike the card's
// own update functions it does NOT check "is the card still open": the panel stays on
// screen, so an AI answer arriving after you closed the popup must still land there.
function sendToPanelReview(channel, payload) {
  if (!panelView || panelView.webContents.isDestroyed()) return;
  panelView.webContents.send(channel, payload);
}

// payload: the review object, or { room, error: true } / { room, spectated: true }.
function showOverlay(payload) {
  // The panel is about to show a different review, so an open replay would belong to the OLD
  // game and clicking a moment would jump it to the wrong turn. Leave it. This is the one place
  // every new review passes through (live battle end, Dev > Open review, errors); updateOverlay
  // (AI text for the SAME review) does not come here. Past games re-opens its replay right after.
  closeReplay();
  showCard(payload);
  sendToPanelReview('review-ready', payload);
}

function updateOverlay(payload) {
  updateCard(payload);
  sendToPanelReview('review-ready', payload);
}

// state: 'pending' | 'unavailable'
function sendAiStatus(state) {
  sendCardStatus(state);
  sendToPanelReview('review-ai-status', state);
}

// One message per frame on 'live-info'. info is a plain object, or null meaning "clear".
function sendLiveInfoToPanel(room, info) {
  if (!panelView || panelView.webContents.isDestroyed()) return;
  panelView.webContents.send('live-info', { room, info });
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
      // For normal users and the demo. No accelerator on purpose: it could clash with Showdown's keys.
      label: 'Games',
      submenu: [
        {
          label: 'Past games…',
          click: () => openReviewForLogFile({ title: 'Open a past game', defaultPath: getLogDir(), withReplay: true }),
        },
        // Does nothing when no replay is open. Wrapped: closeReplay takes no arguments.
        { label: 'Back to Showdown', click: () => closeReplay() },
      ],
    },
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
        // Wrapped so Electron's (menuItem, window, event) click arguments aren't taken as options.
        { label: 'Open review for a log file…', click: () => openReviewForLogFile() },
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
