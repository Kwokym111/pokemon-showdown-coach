// state.js: turns a battle log (array of lines) into a per-turn structure.
// Pure: lines in, data out. No electron, fs or network, so it runs on saved logs in tests.
//
// The idea: walk the lines once, keep a small "current state" (who is active, their HP,
// Tera, ...) and write what happened into the turn we are currently in. Rules and the AI
// later read the finished structure; they never touch raw lines.
//
// Types are deliberately NOT computed here. A Pokémon's current type needs species data
// (and Tera replaces it), which is data.js's job (currentTypes). We only record the inputs:
// species, teraType/terastallized, typeOverride (moves that change type) and
// transformedInto (the species a Ditto/Transform user copied).
//
// Things that change damage are tracked as plain Showdown data, so damage.js can use them:
//  - mon.boosts: stat stages per Pokémon ({ atk, def, spa, spd, spe, accuracy, evasion },
//    -6..6). They end when the Pokémon leaves the field or faints. NOT handled: Baton Pass
//    handing boosts to the next Pokémon.
//  - battle.turns[n].field / .fieldEnd: { weather, terrain, screens: { p1: [], p2: [] } } at
//    the start / end of the turn. `field` is what the player could see when choosing.
//    Values are Showdown's own ids ('SunnyDay', 'Electric Terrain', 'Reflect'); damage.js
//    translates them for the calculator. Hazards are ignored (they do not change move
//    damage). NOT handled: Gravity, Trick Room, Magic/Wonder Room.
// Every one of these lines still also becomes the same generic event as before.

const { parseLine, parseIdent, parseDetails, parseCondition, stripRank } = require('./parser');

const round1 = (n) => Math.round(n * 10) / 10;
const toId = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function freshState() {
  const s = {
    battle: {
      gen: null,
      format: null,
      gameType: null,
      rated: false,
      players: { p1: null, p2: null },
      me: null, // 'p1' | 'p2', learned from |request|; the player is NOT always p1
      teamSize: {},
      turns: [],
      result: { winner: null, winnerSide: null, tie: false, forfeit: false, forfeiter: null, inactive: false, lastTurn: 0 },
      warnings: { unknownCommands: {} },
    },
    mons: new Map(), // "p1|Name" -> mon
    active: { p1: null, p2: null },
    field: { weather: null, terrain: null, screens: { p1: [], p2: [] } },
    turn: null,
    lastMove: null, // the move that following effect lines (-damage, -supereffective...) belong to
  };
  s.turn = newTurn(0, null, snapField(s));
  return s;
}

function newTurn(n, start, field) {
  return {
    turn: n, // 0 = the lead-in switches before turn 1
    start, // active Pokémon at the start of the turn
    field, // weather, terrain and screens at the start of the turn
    fieldEnd: null, // the same at the end of the turn
    available: null, // my choices (from |request|): moves, canTerastallize, switchOptions
    forceSwitch: null, // set when I had to pick a replacement after a faint
    moves: [],
    switches: [],
    faints: [],
    teras: [],
    events: [], // everything, in order, for anything the lists above do not cover
    end: null,
  };
}

function push(s, ev) {
  ev.seq = s.turn.events.length; // position in the turn, so "who moved first" is answerable
  s.turn.events.push(ev);
  return ev;
}

const BOOST_STATS = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];
const zeroBoosts = () => ({ atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 });

const SCREENS = ['Reflect', 'Light Screen', 'Aurora Veil'];

// A copy, so later events cannot change a snapshot that was already stored in a turn.
function snapField(s) {
  const f = s.field;
  return { weather: f.weather, terrain: f.terrain, screens: { p1: [...f.screens.p1], p2: [...f.screens.p2] } };
}

function newMon(side, name) {
  return {
    side, name, species: name, level: 100, gender: null,
    hp: null, maxHp: null, hpPct: null, hpKind: null, status: null, fainted: false,
    terastallized: false, teraType: null, typeOverride: null, transformedInto: null,
    boosts: zeroBoosts(),
    revealedMoves: [], ability: null, item: null, lostItem: null,
    // Only filled for MY Pokémon, from |request| (my own private info):
    moveset: null, plannedTera: null,
  };
}

function getMon(s, ident) {
  const id = parseIdent(ident);
  if (!id) return null;
  const key = `${id.side}|${id.name}`;
  if (!s.mons.has(key)) s.mons.set(key, newMon(id.side, id.name));
  return s.mons.get(key);
}

// Live, my own Pokémon report real HP ("266/266") and opponents a percentage ("85/100").
// But after a reload Showdown replays the history as a spectator sees it, where MY HP is
// a percentage too. So the side alone cannot tell us; the denominator can: /100 means a
// percentage. (A real max HP of exactly 100 would be mislabelled, which is rare and
// harmless.) hpPct is always 0-100 and is what rules should compare.
function refreshHp(s, mon) {
  mon.hpKind = mon.maxHp === 100 ? 'percent' : 'real';
  mon.hpPct = mon.maxHp ? round1((mon.hp / mon.maxHp) * 100) : null;
}

function setCondition(s, mon, conditionText) {
  const c = parseCondition(conditionText);
  if (!c) return;
  mon.hp = c.hp;
  if (c.maxHp !== null) mon.maxHp = c.maxHp; // "0 fnt" has no max, keep the old one
  mon.status = c.status;
  mon.fainted = c.fainted;
  refreshHp(s, mon);
}

function snap(mon) {
  if (!mon) return null;
  return {
    ...mon,
    revealedMoves: [...mon.revealedMoves],
    typeOverride: mon.typeOverride ? [...mon.typeOverride] : null,
    boosts: { ...mon.boosts },
    moveset: mon.moveset ? [...mon.moveset] : null,
  };
}

const snapActive = (s) => ({ p1: snap(s.active.p1), p2: snap(s.active.p2) });

function who(mon) {
  return { side: mon.side, mon: mon.name };
}

// ---------------------------------------------------------------------------
// Handlers, one per protocol command we care about
// ---------------------------------------------------------------------------

function onSwitch(s, { cmd, args, kw }) {
  const mon = getMon(s, args[0]);
  if (!mon) return;
  const d = parseDetails(args[1]);
  mon.species = d.species;
  mon.level = d.level;
  mon.gender = d.gender;
  // A Pokémon that already Terastallized comes back with "tera:Type" in its details.
  if (d.tera) { mon.terastallized = true; mon.teraType = d.tera; }
  setCondition(s, mon, args[2]);

  const prev = s.active[mon.side];
  if (prev && prev !== mon) { // type changes and Transform both end when the Pokémon leaves
    prev.typeOverride = null;
    prev.transformedInto = null;
    prev.boosts = zeroBoosts(); // stat stages end when a Pokémon leaves (Baton Pass not handled)
  }
  s.active[mon.side] = mon;
  s.lastMove = null;

  const ev = push(s, {
    type: cmd, // 'switch' (chosen) or 'drag' (forced, e.g. Roar)
    side: mon.side, mon: mon.name, from: prev && prev !== mon ? prev.name : null,
    hpPct: mon.hpPct, forced: cmd === 'drag', source: kw.from || null,
  });
  s.turn.switches.push(ev);
}

function onMove(s, { args, kw }) {
  const mon = getMon(s, args[0]);
  if (!mon) return;
  const target = parseIdent(args[2]);
  // Moves called by another move ([from], e.g. Sleep Talk) do not reveal the user's own set.
  if (!kw.from && !mon.revealedMoves.includes(args[1])) mon.revealedMoves.push(args[1]);

  const ev = push(s, {
    type: 'move', ...who(mon), move: args[1],
    target: target ? { side: target.side, mon: target.name } : null,
    missed: !!kw.miss, failed: false,
    effectiveness: null, // 'super' | 'resisted' | 'immune', from the effect lines that follow
    immuneBy: null, crit: false,
    hpBefore: null, hpAfter: null, damagePct: 0, hits: 0, knockedOut: false,
    source: kw.from || null,
  });
  s.turn.moves.push(ev);
  s.lastMove = ev;
}

function onDamage(s, { args, kw }) {
  const mon = getMon(s, args[0]);
  if (!mon) return;
  const before = mon.hpPct;
  const cond = parseCondition(args[1]);
  setCondition(s, mon, args[1]);

  // Damage with [from] (Stealth Rock, poison, Life Orb, weather...) is NOT the last move's
  // damage, so it must never be blamed on it.
  const m = s.lastMove;
  const direct = !kw.from && m && mon.side !== m.side;
  push(s, {
    type: 'damage', ...who(mon), hpBefore: before, hpAfter: mon.hpPct,
    indirect: !!kw.from, source: kw.from || null, of: kw.of || null,
    // No [from] and not the mover's target: the Pokémon paid HP itself (Substitute, Belly Drum).
    self: !kw.from && !direct,
  });
  if (direct) {
    if (m.hpBefore === null) m.hpBefore = before; // multi-hit moves: keep the first value
    m.hpAfter = mon.hpPct;
    m.damagePct = round1(m.hpBefore - m.hpAfter);
    m.hits++;
    if (cond && cond.fainted) m.knockedOut = true;
  }
}

function onHeal(s, { cmd, args, kw }) {
  const mon = getMon(s, args[0]);
  if (!mon) return;
  const before = mon.hpPct;
  setCondition(s, mon, args[1]);
  push(s, { type: cmd === '-sethp' ? 'sethp' : 'heal', ...who(mon), hpBefore: before, hpAfter: mon.hpPct, source: kw.from || null, of: kw.of || null });
}

function onFaint(s, { args }) {
  const mon = getMon(s, args[0]);
  if (!mon) return;
  mon.fainted = true;
  mon.hp = 0;
  mon.boosts = zeroBoosts();
  refreshHp(s, mon);
  const ev = push(s, { type: 'faint', ...who(mon) });
  s.turn.faints.push(ev);
  s.lastMove = null;
}

function onTera(s, { args }) {
  const mon = getMon(s, args[0]);
  if (!mon) return;
  mon.terastallized = true;
  mon.teraType = args[1];
  const ev = push(s, { type: 'tera', ...who(mon), teraType: args[1] });
  s.turn.teras.push(ev);
}

// |-supereffective|, |-resisted|, |-immune|, |-crit|, |-miss|, |-fail| describe the move
// that just ran, so they update lastMove instead of being separate events.
function onMoveOutcome(s, { cmd, args, kw }) {
  const m = s.lastMove;
  if (m) {
    if (cmd === '-supereffective') m.effectiveness = 'super';
    else if (cmd === '-resisted') m.effectiveness = 'resisted';
    else if (cmd === '-immune') { m.effectiveness = 'immune'; m.immuneBy = kw.from || null; }
    else if (cmd === '-crit') m.crit = true;
    else if (cmd === '-miss') m.missed = true;
    else if (cmd === '-fail') m.failed = true;
  }
  push(s, { type: cmd.slice(1), mon: args[0] || null, source: kw.from || null });
}

function onRequest(s, { args }) {
  const req = args[0];
  if (!req || !req.side) return;
  const b = s.battle;
  if (b.me === null) b.me = req.side.id; // the first request tells us which side is me

  // My whole team, including benched Pokémon the log has not shown yet. This is MY own
  // private info (items, abilities, moves); nothing about the opponent comes from here.
  const bench = [];
  for (const p of req.side.pokemon || []) {
    const id = parseIdent(p.ident);
    if (!id) continue;
    const mon = getMon(s, p.ident);
    const d = parseDetails(p.details);
    mon.species = d.species;
    mon.level = d.level;
    mon.gender = d.gender;
    mon.item = p.item || null;
    mon.ability = p.ability || null;
    mon.moveset = p.moves || null;
    mon.plannedTera = p.teraType || null;
    if (!p.active) setCondition(s, mon, p.condition); // active ones are tracked by the log lines
    if (!p.active && !mon.fainted) bench.push({ name: mon.name, species: mon.species, hpPct: mon.hpPct, status: mon.status });
  }

  if (req.forceSwitch) {
    s.turn.forceSwitch = { switchOptions: bench };
  } else if (req.active && req.active[0]) {
    const a = req.active[0];
    s.turn.available = {
      moves: (a.moves || []).map((m) => ({ id: m.id, name: m.move, pp: m.pp, maxpp: m.maxpp, disabled: !!m.disabled })),
      canTerastallize: a.canTerastallize || null,
      trapped: !!a.trapped,
      switchOptions: bench,
    };
  }
  // req.wait: nothing to choose, nothing to record
}

function onTurn(s, { args }) {
  closeTurn(s);
  const n = Number(args[0]);
  s.turn = newTurn(n, snapActive(s), snapField(s));
  s.battle.result.lastTurn = n;
  s.lastMove = null;
}

function closeTurn(s) {
  s.turn.end = snapActive(s);
  s.turn.fieldEnd = snapField(s);
  s.battle.turns.push(s.turn);
}

function onPlayer(s, { args }) {
  const side = args[0];
  const name = args[1];
  // "|player|p2|" with no name shows up when a player disconnects (e.g. a page reload).
  // That is not a new player and must not erase the real one.
  if (!name || (side !== 'p1' && side !== 'p2')) return;
  const prev = s.battle.players[side] || {};
  s.battle.players[side] = {
    name,
    avatar: args[2] || prev.avatar || null,
    rating: args[3] ? Number(args[3]) : prev.rating ?? null,
  };
}

function onMessage(s, { args }) {
  const text = args[0] || '';
  const r = s.battle.result;
  let m = /^(.*) forfeited\.$/.exec(text);
  if (m) { r.forfeit = true; r.forfeiter = stripRank(m[1]); return; }
  if (/ lost due to inactivity\.$/.test(text)) { r.inactive = true; return; }
  push(s, { type: 'message', text });
}

function onWin(s, { args }) {
  const r = s.battle.result;
  r.winner = stripRank(args[0]);
  for (const side of ['p1', 'p2']) {
    const p = s.battle.players[side];
    if (p && stripRank(p.name) === r.winner) r.winnerSide = side;
  }
}

// Small "update one field" handlers.
function onDetailsChange(s, { args }) {
  const mon = getMon(s, args[0]);
  if (mon) mon.species = parseDetails(args[1]).species; // |detailschange|, |replace| (Illusion ends)
}
function onFormeChange(s, { args }) {
  const mon = getMon(s, args[0]);
  if (mon) mon.species = args[1];
}
function onAbility(s, { args }) {
  const mon = getMon(s, args[0]);
  if (mon) mon.ability = args[1];
}
function onItem(s, { args }) {
  const mon = getMon(s, args[0]);
  if (mon) mon.item = args[1];
}
function onEndItem(s, { args }) {
  const mon = getMon(s, args[0]);
  if (mon) { mon.lostItem = args[1]; mon.item = null; }
}
function onStatus(s, { cmd, args }) {
  const mon = getMon(s, args[0]);
  if (!mon) return;
  mon.status = cmd === '-status' ? args[1] : null;
}
function onStart(s, { args }) {
  // |-start|p1a: X|typechange|Fire (or "Fire/Flying")
  const mon = getMon(s, args[0]);
  if (mon && args[1] === 'typechange' && args[2]) mon.typeOverride = args[2].split('/');
}
// |-transform|p2a: Ditto|p1a: Pawmot|[from] ability: Imposter
// The copier takes on the target's types, so remember who it copied. We still keep the
// generic event (same shape as the fallback in buildBattle) so nothing is lost.
function onTransform(s, { cmd, args, kw }) {
  const mon = getMon(s, args[0]);
  const target = getMon(s, args[1]);
  if (mon && target) mon.transformedInto = target.species;
  push(s, { type: cmd.slice(1), args, kw });
}
// Effects below change state AND stay in the event list, exactly like the generic fallback
// in buildBattle did before they were modelled.
function recordGeneric(s, { cmd, args, kw }) {
  push(s, { type: cmd.slice(1), args, kw });
}

const clampBoost = (n) => Math.max(-6, Math.min(6, n));

function onBoost(s, parsed) {
  const { cmd, args } = parsed;
  const mon = getMon(s, args[0]);
  const stat = args[1];
  const n = Number(args[2]);
  if (mon && stat in mon.boosts && Number.isFinite(n)) {
    if (cmd === '-boost') mon.boosts[stat] = clampBoost(mon.boosts[stat] + n);
    else if (cmd === '-unboost') mon.boosts[stat] = clampBoost(mon.boosts[stat] - n);
    else mon.boosts[stat] = clampBoost(n); // -setboost
  }
  recordGeneric(s, parsed);
}

// -clearboost, -clearpositiveboost, -clearnegativeboost, -invertboost (all on args[0]);
// -clearallboost (everyone on the field).
function onBoostReset(s, parsed) {
  const { cmd, args } = parsed;
  const targets = cmd === '-clearallboost' ? [s.active.p1, s.active.p2] : [getMon(s, args[0])];
  for (const mon of targets) {
    if (!mon) continue;
    for (const stat of BOOST_STATS) {
      const v = mon.boosts[stat];
      if (cmd === '-clearpositiveboost' && v > 0) mon.boosts[stat] = 0;
      else if (cmd === '-clearnegativeboost' && v < 0) mon.boosts[stat] = 0;
      else if (cmd === '-invertboost') mon.boosts[stat] = -v || 0;
      else if (cmd === '-clearboost' || cmd === '-clearallboost') mon.boosts[stat] = 0;
    }
  }
  recordGeneric(s, parsed);
}

// |-swapboost|SOURCE|TARGET|atk, spa   (Guard/Power Swap: only the listed stats; none = all)
// |-copyboost|SOURCE|TARGET            (Psych Up: SOURCE copies the boosts of TARGET)
function onBoostCopy(s, parsed) {
  const { cmd, args } = parsed;
  const a = getMon(s, args[0]);
  const b = getMon(s, args[1]);
  if (a && b) {
    const stats = cmd === '-swapboost' && args[2] ? args[2].split(',').map((x) => x.trim()) : BOOST_STATS;
    for (const stat of stats) {
      if (!(stat in a.boosts)) continue;
      if (cmd === '-swapboost') [a.boosts[stat], b.boosts[stat]] = [b.boosts[stat], a.boosts[stat]];
      else a.boosts[stat] = b.boosts[stat];
    }
  }
  recordGeneric(s, parsed);
}

// |-weather|SunnyDay (or 'none'). The same line with [upkeep] repeats every turn: harmless.
function onWeather(s, parsed) {
  s.field.weather = parsed.args[0] === 'none' ? null : parsed.args[0] || null;
  recordGeneric(s, parsed);
}

// |-fieldstart|move: Electric Terrain|[from] ability: ...   /   |-fieldend|move: Electric Terrain
function onFieldEffect(s, parsed) {
  const name = (parsed.args[0] || '').replace(/^move: /, '');
  if (/ Terrain$/.test(name)) s.field.terrain = parsed.cmd === '-fieldstart' ? name : null;
  recordGeneric(s, parsed);
}

// |-sidestart|p1: Name|move: Reflect   /   |-sideend|p1: Name|Reflect   (hazards are ignored)
function onSideCondition(s, parsed) {
  const side = (parsed.args[0] || '').slice(0, 2);
  const name = (parsed.args[1] || '').replace(/^move: /, '');
  const list = s.field.screens[side];
  if (list && SCREENS.includes(name)) {
    const i = list.indexOf(name);
    if (parsed.cmd === '-sidestart' && i === -1) list.push(name);
    if (parsed.cmd === '-sideend' && i !== -1) list.splice(i, 1);
  }
  recordGeneric(s, parsed);
}

function onCant(s, { args }) {
  const mon = getMon(s, args[0]);
  if (mon) push(s, { type: 'cant', ...who(mon), reason: args[1] || null, move: args[2] || null });
}

const HANDLERS = {
  switch: onSwitch, drag: onSwitch,
  move: onMove,
  '-damage': onDamage, '-heal': onHeal, '-sethp': onHeal,
  faint: onFaint,
  '-terastallize': onTera,
  '-supereffective': onMoveOutcome, '-resisted': onMoveOutcome, '-immune': onMoveOutcome,
  '-crit': onMoveOutcome, '-miss': onMoveOutcome, '-fail': onMoveOutcome,
  request: onRequest,
  turn: onTurn,
  player: onPlayer,
  win: onWin,
  '-message': onMessage,
  replace: onDetailsChange, detailschange: onDetailsChange, '-formechange': onFormeChange,
  '-ability': onAbility, '-item': onItem, '-enditem': onEndItem,
  '-status': onStatus, '-curestatus': onStatus,
  '-start': onStart,
  '-boost': onBoost, '-unboost': onBoost, '-setboost': onBoost,
  '-clearboost': onBoostReset, '-clearpositiveboost': onBoostReset, '-clearnegativeboost': onBoostReset,
  '-clearallboost': onBoostReset, '-invertboost': onBoostReset,
  '-swapboost': onBoostCopy, '-copyboost': onBoostCopy,
  '-weather': onWeather,
  '-fieldstart': onFieldEffect, '-fieldend': onFieldEffect,
  '-sidestart': onSideCondition, '-sideend': onSideCondition,
  '-transform': onTransform,
  cant: onCant,
  gen: (s, { args }) => { s.battle.gen = Number(args[0]); },
  tier: (s, { args }) => { s.battle.format = args[0]; },
  gametype: (s, { args }) => { s.battle.gameType = args[0]; },
  rated: (s) => { s.battle.rated = true; },
  teamsize: (s, { args }) => { s.battle.teamSize[args[0]] = Number(args[1]); },
  tie: (s) => { s.battle.result.tie = true; },
  upkeep: (s) => { s.lastMove = null; },
};

// Commands that carry nothing we use. Listed so they are not reported as "unknown".
const IGNORED = new Set([
  'init', 'title', 'j', 'join', 'l', 'leave', 'start', 'rule', 'clearpoke', 'poke', 'teampreview',
  'deinit', 'error', 'sentchoice', 'askreg', 'uhtml', 'html', 'n', 'name',
]);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function buildBattle(lines) {
  let s = freshState();

  for (const line of lines) {
    // A second |init|battle means Showdown replayed the room (reload/rejoin): start over,
    // the same rule the log writer follows, so a log with repeated history still works.
    if (line === '|init|battle') { s = freshState(); continue; }

    const parsed = parseLine(line);
    if (!parsed) continue;

    const handler = HANDLERS[parsed.cmd];
    if (handler) handler(s, parsed);
    else if (parsed.cmd.startsWith('-')) {
      // Minor effects we do not model yet (hazards, abilities...). Kept
      // in the event list so nothing is lost for the rules or the AI later.
      push(s, { type: parsed.cmd.slice(1), args: parsed.args, kw: parsed.kw });
    } else if (!IGNORED.has(parsed.cmd)) {
      const u = s.battle.warnings.unknownCommands;
      u[parsed.cmd] = (u[parsed.cmd] || 0) + 1;
    }
  }

  closeTurn(s);
  return s.battle;
}

module.exports = { buildBattle, toId };
