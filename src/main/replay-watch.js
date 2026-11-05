// replay-watch.js: safety net for the replay page. Showdown's player loads ~16 scripts from the
// internet, and now and then it fails to start ("$ is not defined"). This watches one replay
// webContents and, if the replay really is not running a few seconds after load, reloads the
// page ONCE. The retry count lives here (in main), not in the page, so the page can never
// reload itself in a loop.
//
// It takes a webContents (not a window) so it keeps working when the replay moves into a view.

const CHECK_AFTER_MS = 6000; // time after each page load before we judge whether it started
const MAX_RETRIES = 1;

// Runs inside the page. "Running" = the player created its battle AND drew its controls, or
// the page is already showing the offline message (no internet: retrying would not help and
// would flash the message twice).
const PAGE_STATE_JS = `(() => {
  const offline = document.getElementById('offline');
  const controls = document.querySelector('.replay-controls');
  return {
    offline: !!offline && !offline.hidden,
    running: typeof Replays !== 'undefined' && !!Replays.battle && !!controls && controls.children.length > 0,
  };
})()`;

const SHOW_FAILED_JS = `(() => {
  const w = document.querySelector('.wrapper');
  if (w) w.hidden = true;
  const f = document.getElementById('failed');
  if (f) f.hidden = false;
})()`;

// onEvent(type, detail) is for logging/tests: 'ok' | 'retry' | 'gave-up'.
// Returns { stop() } to cancel the pending timer (call it when the replay is closed/replaced).
function watchReplayStart(wc, { checkAfterMs = CHECK_AFTER_MS, maxRetries = MAX_RETRIES, onEvent = () => {} } = {}) {
  let retries = 0;
  let timer = null;

  const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };

  // Why a timer after did-finish-load and not "on the first $ error": the error alone can be
  // harmless (our start-up code waits for the scripts and may still recover). Only judge on
  // whether the replay is actually running.
  wc.on('did-finish-load', () => {
    stop();
    timer = setTimeout(check, checkAfterMs);
  });
  wc.once('destroyed', stop);

  async function check() {
    timer = null;
    if (wc.isDestroyed()) return;
    let state;
    try {
      state = await wc.executeJavaScript(PAGE_STATE_JS);
    } catch (err) {
      state = { offline: false, running: false }; // page is broken enough that we cannot even ask
    }
    if (wc.isDestroyed()) return;
    if (state.running || state.offline) { onEvent('ok', state); return; }

    if (retries < maxRetries) {
      retries++;
      onEvent('retry', { attempt: retries });
      wc.reload(); // did-finish-load will arm the check again
    } else {
      onEvent('gave-up', {});
      wc.executeJavaScript(SHOW_FAILED_JS).catch(() => {});
    }
  }

  return { stop, get retries() { return retries; } };
}

module.exports = { watchReplayStart };
