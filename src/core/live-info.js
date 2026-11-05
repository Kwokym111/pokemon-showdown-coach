// Pure core (no electron, fs, network or timers): turns the battle's lines so far into
// what the live panel shows.
//
// COMPLIANCE (CLAUDE.md rule 8): this file may only output things that are already visible in
// the battle, plus static type-chart data. It never recommends, predicts or reveals anything
// hidden. For the opponent that means: no moveset, item, unrevealed ability or planned Tera type. The
// opponent object below is therefore built field by field from a fixed whitelist instead of
// being spread from the state, so a field added to the state later cannot leak by accident.

const { buildBattle } = require('./state');
const { currentTypes, typeChart, getMove, getSpecies, getAbility, getStatusName, getFieldEffect, getVolatile } = require('./data');

// The order stat stages are listed in. These are Showdown's own boost keys (as in state.js).
const BOOST_ORDER = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];

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

  // Effects on the Pokémon that the log has shown. A fainted Pokémon has none ("fnt" is not
  // a status worth a badge; the panel has its own Fainted flag for that).
  const status = mon.fainted ? null : (mon.status || null);
  // Only stat stages that are not 0, in a fixed order. Stages are public (the log announces
  // every boost and drop) and the state resets them on switch-out and faint.
  const boosts = [];
  if (!mon.fainted) {
    for (const stat of BOOST_ORDER) {
      const stages = mon.boosts ? mon.boosts[stat] : 0;
      if (stages) boosts.push({ stat, stages });
    }
  }
  // Temporary effects the log announced (Leech Seed, Substitute...). Names only, plus the
  // move's one-line description. Nothing about WHICH move was disabled etc. is kept by state.
  const volatiles = mon.fainted ? [] : (mon.volatiles || []).map((v) => getVolatile(gen, v)).filter(Boolean);
  return {
    name: mon.name,
    species: mon.species,
    types,
    terastallized: !!mon.terastallized,
    status,
    statusName: getStatusName(status),
    boosts,
    volatiles,
    weak, resist, immune,
  };
}

// A weather, terrain or screen id from the state -> { name, shortDesc } (or just the id).
function fieldEffect(gen, id) {
  return getFieldEffect(gen, id) || { name: String(id), shortDesc: '' };
}

// What covers the field right now, from the end snapshot of the current turn. Screens are per
// side; the panel talks about "your side" and "their side".
function describeField(gen, fieldEnd, mySide) {
  const oppSide = mySide === 'p1' ? 'p2' : 'p1';
  const f = fieldEnd || { weather: null, terrain: null, screens: { p1: [], p2: [] }, sideEffects: { p1: [], p2: [] } };
  // Screens first, then hazards and other side conditions. `layers` is 1 except for stacked
  // hazards (Spikes up to 3, Toxic Spikes up to 2).
  const list = (side) => [
    ...((f.screens && f.screens[side]) || []).map((id) => ({ ...fieldEffect(gen, id), layers: 1 })),
    ...((f.sideEffects && f.sideEffects[side]) || []).map((e) => ({ ...fieldEffect(gen, e.name), layers: e.layers })),
  ];
  return {
    weather: f.weather ? fieldEffect(gen, f.weather) : null,
    terrain: f.terrain ? fieldEffect(gen, f.terrain) : null,
    mySide: list(mySide),
    oppSide: list(oppSide),
  };
}

function describeOpponent(gen, mon) {
  const base = describeMon(gen, mon);
  // Only moves the opponent has actually used so far (state records them from |move| lines).
  const revealedMoves = (mon.revealedMoves || []).map((name) => {
    const mv = getMove(gen, name);
    return {
      name,
      type: mv ? mv.type : null,
      category: mv ? mv.category : null,
      basePower: mv ? mv.basePower : null,
      accuracy: mv ? mv.accuracy : null, // a number, or true = never misses
      shortDesc: mv ? mv.shortDesc : '',
    };
  });

  // Static reference data about the SPECIES (Showdown shows the same on hover). Using
  // mon.species even if transformed, to keep it simple.
  const sp = getSpecies(gen, mon.species);
  const possibleAbilities = sp
    ? sp.abilities.map((n) => {
        const ab = getAbility(gen, n);
        return { name: n, shortDesc: ab ? ab.shortDesc : '' };
      })
    : [];
  // For the opponent, state only fills mon.ability from the log (|-ability|, [from] ability:
  // tags), never from a |request|, so a non-null value here has really been shown in battle.
  const revealedAbility = mon.ability || null;

  return {
    name: base.name,
    species: base.species,
    types: base.types,
    terastallized: base.terastallized,
    hpPct: mon.hpPct,
    fainted: !!mon.fainted,
    status: base.status,
    statusName: base.statusName,
    boosts: base.boosts,
    volatiles: base.volatiles,
    weak: base.weak,
    resist: base.resist,
    immune: base.immune,
    revealedMoves,
    baseStats: sp ? sp.baseStats : null,
    possibleAbilities,
    revealedAbility,
  };
}

// null when there is nothing to show: no |request| yet (spectating, or the battle has not
// started for us) or no |turn| line yet.
function buildLiveInfo(lines) {
  const battle = buildBattle(lines);
  if (!battle.me || battle.gen === null) return null;

  // The latest turn that has a start snapshot (turn 0, the lead-in, has none). We then read its
  // END snapshot, which buildBattle fills for the turn still in progress too: the state right
  // after the last line received. The START snapshot was the old choice, and it hid everything
  // that happened after `|turn|N` until `|turn|N+1`, which does not arrive while someone is
  // picking a replacement after a faint or U-turn (and never shows a Pokémon that moved and
  // then fainted).
  let turn = null;
  for (let i = battle.turns.length - 1; i >= 0; i--) {
    if (battle.turns[i].start) { turn = battle.turns[i]; break; }
  }
  if (!turn || !turn.end) return null;

  const mySide = battle.me;
  const oppSide = mySide === 'p1' ? 'p2' : 'p1';
  const oppMon = turn.end[oppSide];
  const myMon = turn.end[mySide];
  const r = battle.result;

  // Every opponent Pokémon that has been on the field, in order of first appearance, each
  // described exactly like the active one. Nothing about Pokémon that have not appeared.
  const team = battle.mons.filter((m) => m.side === oppSide);
  const opponentTeam = team.map((m) => ({
    ...describeOpponent(battle.gen, m),
    active: !!oppMon && m.name === oppMon.name,
  }));
  // How many of its team we have not seen: just the team size (public, Showdown shows it).
  const size = battle.teamSize[oppSide];
  const unseenCount = Number.isInteger(size) ? Math.max(0, size - team.length) : 0;

  return {
    turn: turn.turn,
    ended: !!(r.winner || r.tie || r.forfeit),
    opponent: oppMon ? describeOpponent(battle.gen, oppMon) : null,
    opponentTeam,
    unseenCount,
    field: describeField(battle.gen, turn.fieldEnd, mySide),
    me: myMon ? describeMon(battle.gen, myMon) : null,
  };
}

module.exports = { buildLiveInfo };
