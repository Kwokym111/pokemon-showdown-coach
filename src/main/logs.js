// logs.js: writes captured battle lines to <userData>/battle-logs/<roomid>.log.
// Kept separate from capture so "where do lines come from" and "where do they go" can
// change independently (task 2 will change how a file is started).

const path = require('path');
const fs = require('fs');

let logDir; // set once by initLogs(), after the app is ready

function initLogs(userDataPath) {
  logDir = path.join(userDataPath, 'battle-logs');
  fs.mkdirSync(logDir, { recursive: true });
  return logDir;
}

function getLogDir() {
  return logDir;
}

// Returns { fresh }: true when this write started the room's file over.
function writeLines(room, lines) {
  // The room id comes from a remote server, so never trust it as a file name:
  // strip anything except letters, digits, "-" and "_" (blocks "../" tricks).
  const safe = room.replace(/[^A-Za-z0-9_-]/g, '_');
  const file = path.join(logDir, `${safe}.log`);

  // Showdown replays the room's whole history every time the page joins it (reload,
  // rejoin), and every replay starts with |init|battle. So that line means "a fresh copy
  // of the room begins here": discard what we have instead of appending a duplicate.
  // Later frames of the same battle have no |init|, so they still append.
  const initIndex = lines.indexOf('|init|battle');
  if (initIndex !== -1) {
    fs.writeFileSync(file, lines.slice(initIndex).join('\n') + '\n');
    return { fresh: true };
  }

  fs.appendFileSync(file, lines.join('\n') + '\n');
  return { fresh: false };
}

module.exports = { initLogs, getLogDir, writeLines };
