// requests.js: put earlier |request| lines back into a replayed battle log.
//
// Why this exists: when the page reloads, Showdown replays the room's history, and that
// replay has NO old |request| lines, only the current one. logs.js starts the file fresh
// from the replay, which would throw away the requests we had already captured. Those
// tell us which moves were available each turn, so the review needs them.
//
// Pure: arrays of lines in, array of lines out. No fs, so it is testable on saved logs.

const REQUEST = '|request|';

// 'active' (my move choices), 'forceSwitch' (pick a replacement), or null (wait / unreadable).
// "wait" requests carry no choice, so they are never worth restoring.
function requestKind(line) {
  try {
    const req = JSON.parse(line.slice(REQUEST.length));
    if (req.forceSwitch) return 'forceSwitch';
    if (req.active) return 'active';
  } catch {
    // a damaged request line is simply not restored
  }
  return null;
}

const turnOf = (line) => {
  const m = /^\|turn\|(\d+)$/.exec(line);
  return m ? Number(m[1]) : null;
};

// Newest request of each kind per turn, taken from the file we are about to overwrite.
function collectSaved(oldLines) {
  const saved = new Map(); // turn -> { active?: line, forceSwitch?: line }
  let turn = 0;
  for (const line of oldLines) {
    const t = turnOf(line);
    if (t !== null) turn = t;
    if (turn < 1 || !line.startsWith(REQUEST)) continue;
    const kind = requestKind(line);
    if (!kind) continue;
    if (!saved.has(turn)) saved.set(turn, {});
    saved.get(turn)[kind] = line; // latest wins (Showdown re-sends after errors/reconnects)
  }
  return saved;
}

// Returns newLines with saved requests inserted. Only |turn|N is used as an anchor: a
// replay is not line-for-line identical to what we captured live (my own HP comes back as
// a percentage, join lines are ordered differently), but turn numbers always match.
//   active      -> right after |turn|N
//   forceSwitch -> at the end of turn N, i.e. just before |turn|N+1 (or at the very end)
// A request already present in the replay for that turn and kind is the live one and wins.
// Because of that, running this twice gives the same result: reloads do not pile up copies.
function restoreRequests(newLines, oldLines) {
  const saved = collectSaved(oldLines);
  if (saved.size === 0) return newLines;

  const present = new Set(); // "turn:kind" already in the replay
  let turn = 0;
  for (const line of newLines) {
    const t = turnOf(line);
    if (t !== null) turn = t;
    if (line.startsWith(REQUEST)) present.add(`${turn}:${requestKind(line)}`);
  }

  const out = [];
  const addMissing = (n, kind) => {
    const line = saved.get(n) && saved.get(n)[kind];
    if (line && !present.has(`${n}:${kind}`)) out.push(line);
  };

  turn = 0;
  for (const line of newLines) {
    const t = turnOf(line);
    if (t !== null) addMissing(turn, 'forceSwitch'); // the turn that is ending
    out.push(line);
    if (t !== null) {
      turn = t;
      addMissing(turn, 'active');
    }
  }
  addMissing(turn, 'forceSwitch'); // the last turn in the replay has no "next turn" line
  return out;
}

module.exports = { restoreRequests };
