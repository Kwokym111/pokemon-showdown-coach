// replay-page.js: puts our captured log where Showdown's replay player expects it, then
// starts the player. Must be loaded AFTER replay-embed.js (see replay.html).

// First thing, before anything below can bail out: the Back button must work even when the
// player failed to load (offline message). addEventListener, not an inline onclick, because
// the CSP forbids inline handlers.
document.getElementById('back').addEventListener('click', () => window.replayAPI.close());

// textContent (not innerHTML) so a "</script>" or HTML inside the log is just text.
document.querySelector('script.battle-log-data').textContent = window.replayAPI.getLog() || '';

// Why we start the player ourselves: replay-embed.js calls Replays.init() from window.onload
// and adds its ~16 scripts dynamically. In Electron the load event sometimes fires before
// jQuery has run (seen in about 1 start in 5: "$ is not defined"). So we drop its onload and
// call init() once everything it needs exists.
window.onload = null;

// Globals the player needs, from the scripts replay-embed.js loads.
const NEEDED = ['$', 'Battle', 'BattleSound', 'BattleLog', 'BattleTooltips',
  'BattlePokedex', 'BattleMovedex', 'BattleAbilities', 'BattleItems', 'Config'];
// Shorter than before: this only covers scripts that fail AFTER replay-embed.js itself loaded.
// (The main process also runs a separate check; see src/main/replay-watch.js.)
const GIVE_UP_AFTER_MS = 10000;
const started = Date.now();

function showOffline() {
  document.getElementById('offline').hidden = false;
  document.querySelector('.wrapper').hidden = true;
}

// The <script> tags in replay.html run in order. If Replays is still undefined here,
// replay-embed.js itself did not load (no internet), and no amount of polling will help:
// say so immediately instead of making the user wait.
if (typeof Replays === 'undefined') {
  console.warn('[replay] replay-embed.js did not load');
  showOffline();
  throw new Error('replay-embed.js did not load'); // stops this script; nothing left to start
}

function tryStart() {
  const ready = typeof Replays !== 'undefined' && NEEDED.every((name) => typeof window[name] !== 'undefined');
  if (ready) {
    Replays.init();
    return;
  }
  // No internet: the scripts never arrive, so stop waiting and say why.
  if (Date.now() - started > GIVE_UP_AFTER_MS) {
    console.warn('[replay] player scripts did not load; missing:',
      NEEDED.filter((name) => typeof window[name] === 'undefined').join(', ') || '(Replays)');
    showOffline();
    return;
  }
  setTimeout(tryStart, 100);
}
tryStart();
