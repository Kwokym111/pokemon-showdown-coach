// Pure core (no electron, fs, network or timers): turns the battle's lines so far into
// what the live panel shows.
//
// COMPLIANCE (CLAUDE.md rule 8): this file may only output things that are already visible in
// the battle, plus static type-chart data. It never recommends, predicts or reveals anything
// hidden. For the opponent that means: no moveset, item, ability or planned Tera type. The
// opponent object below is therefore built field by field from a fixed whitelist instead of
// being spread from the state, so a field added to the state later cannot leak by accident.

const { buildBattle } = require('./state');
const { currentTypes, typeChart, getMove } = require('./data');

// Splits a type chart ({ Fire: 2, Water: 0.5, ... }) into plain, sorted lists.
function matchups(chart) {
  const weak = [];
  const resist = [];
  const immune = [];
  if (chart) {
    for (const [type, x] of Object.entries(chart)) {
      if (x === 0) immune.push(type);
      else if (x >= 2) weak.push({ type, x });
      else if (x < 1) resist.push({ type, x });
    }
  }
  // Strongest effect first (4x before 2x, 0.25x before 0.5x), then A to Z so the order is stable.
  weak.sort((a, b) => b.x - a.x || a.type.localeCompare(b.type));
  resist.sort((a, b) => a.x - b.x || a.type.localeCompare(b.type));
  immune.sort();
  return { weak, resist, immune };
}

// The part both sides share: name, current types (Tera only once it has happened) and matchups.
function describeMon(gen, mon) {
  // currentTypes only reads teraType when mon.terastallized is true, so a planned Tera type
  // that has not been used yet can never show up here. null (unknown species) -> empty lists.
  const types = currentTypes(gen, mon) || [];
  const { weak, resist, immune } = matchups(types.length ? typeChart(gen, types) : null);
  return {
    name: mon.name,
    species: mon.species,
    types,
    terastallized: !!mon.terastallized,
    weak, resist, immune,
  };
}

function describeOpponent(gen, mon) {
  const base = describeMon(gen, mon);
  // Only moves the opponent has actually used so far (state records them from |move| lines).
  const revealedMoves = (mon.revealedMoves || []).map((name) => {
    const mv = getMove(gen, name);
    return { name, type: mv ? mv.type : null, category: mv ? mv.category : null };
  });
  return {
    name: base.name,
    species: base.species,
    types: base.types,
    terastallized: base.terastallized,
    hpPct: mon.hpPct,
    status: mon.status || null,
    weak: base.weak,
    resist: base.resist,
    immune: base.immune,
    revealedMoves,
  };
}

// null when there is nothing to show: no |request| yet (spectating, or the battle has not
// started for us) or no |turn| line yet.
function buildLiveInfo(lines) {
  const battle = buildBattle(lines);
  if (!battle.me || battle.gen === null) return null;

  // The latest turn whose start snapshot exists: the state the player is choosing for.
  // (Turn 0 has start === null; buildBattle also closes the in-progress turn, so it is included.)
  let turn = null;
  for (let i = battle.turns.length - 1; i >= 0; i--) {
    if (battle.turns[i].start) { turn = battle.turns[i]; break; }
  }
  if (!turn) return null;

  const mySide = battle.me;
  const oppSide = mySide === 'p1' ? 'p2' : 'p1';
  const oppMon = turn.start[oppSide];
  const myMon = turn.start[mySide];
  const r = battle.result;

  return {
    turn: turn.turn,
    ended: !!(r.winner || r.tie || r.forfeit),
    opponent: oppMon ? describeOpponent(battle.gen, oppMon) : null,
    me: myMon ? describeMon(battle.gen, myMon) : null,
  };
}

module.exports = { buildLiveInfo };
