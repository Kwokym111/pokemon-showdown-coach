// Main-process side of the live panel. main.js calls handleLines() for every captured
// frame; this file remembers the lines per room and asks the pure core what to show.
// Faysal's file: main.js never needs to change for live-info work.

const { buildLiveInfo } = require('../core/live-info');

// room id -> every line seen so far in that room's current copy of the battle.
// Never freed: a session has a handful of rooms of a few hundred lines each.
const linesByRoom = new Map();

// Returns a plain object to show, or null for "nothing to show / clear".
// Must never throw: it runs inside capture, and a bug here must not break logging.
function handleLines(room, lines, { fresh }) {
  try {
    let seen = linesByRoom.get(room) || [];
    if (fresh) {
      // Showdown replays the whole room on every join and the replay starts at
      // |init|battle, so start over from there (same rule as writeLines in logs.js).
      const initIndex = lines.indexOf('|init|battle');
      seen = initIndex === -1 ? [] : lines.slice(initIndex);
    } else {
      seen = seen.concat(lines);
    }
    linesByRoom.set(room, seen);
    return buildLiveInfo(seen);
  } catch (err) {
    console.error('[live-info] failed:', err.message);
    return null;
  }
}

module.exports = { handleLines };
