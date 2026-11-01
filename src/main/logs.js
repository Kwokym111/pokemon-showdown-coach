// logs.js: writes captured battle lines to <userData>/battle-logs/<roomid>.log.
// Kept separate from capture so "where do lines come from" and "where do they go" can
// change independently (task 2 will change how a file is started).

const path = require('path');
const fs = require('fs');
const { restoreRequests } = require('../core/requests');

let logDir; // set once by initLogs(), after the app is ready

function initLogs(userDataPath) {
  logDir = path.join(userDataPath, 'battle-logs');
  fs.mkdirSync(logDir, { recursive: true });
  return logDir;
}

function getLogDir() {
  return logDir;
}

function readLinesIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return []; // first time we see this room: nothing to carry over
  }
}

// The single place that turns a room id into a file path, so writing and reading a log
// can never disagree about the name.
function getLogPath(room) {
  // The room id comes from a remote server, so never trust it as a file name:
  // strip anything except letters, digits, "-" and "_" (blocks "../" tricks).
  const safe = room.replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(logDir, `${safe}.log`);
}

// Returns the room's whole log as text, or null if there is no file for it yet.
function readLog(room) {
  try {
    return fs.readFileSync(getLogPath(room), 'utf8');
  } catch {
    return null;
  }
}

// Returns { fresh }: true when this write started the room's file over.
function writeLines(room, lines) {
  const file = getLogPath(room);

  // Showdown replays the room's whole history every time the page joins it (reload,
  // rejoin), and every replay starts with |init|battle. So that line means "a fresh copy
  // of the room begins here": discard what we have instead of appending a duplicate.
  // Later frames of the same battle have no |init|, so they still append.
  const initIndex = lines.indexOf('|init|battle');
  if (initIndex !== -1) {
    // The replay carries no old |request| lines (only the current one), so carry the ones
    // we already saved over into the new file before it replaces the old one.
    const kept = restoreRequests(lines.slice(initIndex), readLinesIfExists(file));
    fs.writeFileSync(file, kept.join('\n') + '\n');
    return { fresh: true };
  }

  fs.appendFileSync(file, lines.join('\n') + '\n');
  return { fresh: false };
}

module.exports = { initLogs, getLogDir, getLogPath, readLog, writeLines };
