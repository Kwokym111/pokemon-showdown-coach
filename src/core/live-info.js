// Pure core (no electron, fs, network or timers): turns the battle's lines so far into
// what the live panel shows. Stub for now: it only proves the wiring works end to end.
// Faysal's file. Only use info already revealed in the battle plus static reference data.

function buildLiveInfo(lines) {
  return { linesSeen: lines.length };
}

module.exports = { buildLiveInfo };
