// panel.js: normal page JavaScript for the panel (renderer process).
// window.panelAPI exists because panel-preload.js put it there.

// CLAUDE.md asked for the last 30 lines, but |request| lines are ~2,700 characters each
// and fill that window. So: keep more lines, and shorten long ones on screen only.
// The .log file on disk always gets the full, untouched line.
const MAX_LINES = 500;
const MAX_LINE_CHARS = 160;
const recent = [];
let total = 0;

const countEl = document.getElementById('count');
const roomEl = document.getElementById('room');
const logEl = document.getElementById('log');

function shorten(line) {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} … (+${line.length - MAX_LINE_CHARS} chars)` : line;
}

window.panelAPI.onLine(({ room, line }) => {
  total++;
  recent.push(shorten(line));
  if (recent.length > MAX_LINES) recent.shift();

  countEl.textContent = total;
  roomEl.textContent = room;

  // Only follow new lines if you are already at the bottom, so you can scroll back
  // and read older lines without being yanked down every time a line arrives.
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  // textContent (not innerHTML) because lines contain player-chosen text from the server.
  logEl.textContent = recent.join('\n');
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
});
