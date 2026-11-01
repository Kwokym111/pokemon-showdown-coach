// capture.js: battle capture via the Chrome DevTools Protocol (R5).
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

// onLines(room, lines) is called for every battle message. A callback (instead of
// requiring logs.js and the panel here) keeps capture independent of what we do with
// the lines.
function attachBattleCapture(webContents, onLines) {
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
        onLines(room, lines);
      }
    } catch (err) {
      console.error('[capture] error handling a frame:', err);
    }
  });
}

module.exports = { decodeFrame, attachBattleCapture };
