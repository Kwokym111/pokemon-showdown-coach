// review.js: decides which of the PLAYER's decisions in a finished battle were notable and
// labels them. Pure: a battle object in, a review object out. No electron, fs, network,
// timers, Date or randomness, so the same battle always gives the same review.
//
// Output format: docs/review-format.md. The AI step (task 6) only fills in `summary` and
// each `explanation`; labels are assigned here and never by the AI. The `facts` of every
// moment mirror handoff/sample-review.json (same keys, same order) because the AI prompt
// is written against that file. Change a facts shape and that prompt breaks.
//
// Rules so far:
//   move-into-immunity            my move did nothing because the target is immune   -> mistake
//   switched-into-super-effective I switched in and took a big super-effective hit   -> mistake / blunder
//   switched-into-immunity        I switched in and the opponent's move did nothing  -> great
//
// A moment is only emitted when the player COULD HAVE KNOWN what would happen when they
// chose. Both players pick at the start of a turn, so anything that changes during the
// turn (the opponent switching in, Terastallizing) is not held against the player.
//
// Every Pokémon fact comes from data.js with the battle's generation. Anything data.js
// does not know (it returns null) means "skip this moment", never a guess.

const { getMove, typeMultiplier, currentTypes } = require('./data');

// Every number and list that tunes the rules lives here.
const CONFIG = {
  // switched-into-super-effective: share of max HP the incoming Pokémon lost.
  blunderDamagePct: 50, // this much, or a knock-out, is a blunder
  mistakeDamagePct: 25, // this much is a mistake; less than this is not worth flagging
  labels: { moveIntoImmunity: 'mistake', switchedIntoImmunity: 'great' },
  // Moves whose real type depends on the situation. data.js only knows their base type, so
  // we never judge a type matchup that rests on one of them. (A move list, not a type chart.)
  situationalTypeMoves: [
    'Tera Blast', 'Weather Ball', 'Hidden Power', 'Judgment', 'Revelation Dance',
    'Terrain Pulse', 'Multi-Attack', 'Natural Gift', 'Techno Blast', 'Raging Bull',
    'Ivy Cudgel', 'Aura Wheel', 'Tera Starstorm',
  ],
};

const otherSide = (side) => (side === 'p1' ? 'p2' : 'p1');

// ---------------------------------------------------------------------------
// Looking things up in earlier turns
// ---------------------------------------------------------------------------

// The turn (< ti) in which `name` last came onto the field for `side`, or null if the log
// does not show it. Used to say "had been in play since turn N".
function entryTurn(battle, ti, side, name) {
  for (let j = ti - 1; j >= 0; j--) {
    if (battle.turns[j].switches.some((s) => s.side === side && s.mon === name)) return j;
  }
  return null;
}

// The turn (< ti) in which `mon` first used `move` (not via another move).
function firstUseTurn(battle, ti, side, name, move) {
  for (let j = 1; j < ti; j++) {
    if (battle.turns[j].moves.some((m) => m.side === side && m.mon === name && m.move === move && !m.source)) return j;
  }
  return null;
}

function teraTurn(battle, ti, side, name) {
  for (let j = 1; j < ti; j++) {
    if (battle.turns[j].teras.some((t) => t.side === side && t.mon === name)) return j;
  }
  return null;
}

// The state of MY Pokémon as it came in, enough for currentTypes. The `switch` event does not
// carry it, and a Pokémon that was knocked out the same turn is no longer in turn.end, so:
//  1. the latest snapshot from an earlier turn (carries Tera state),
//  2. else turn.end, else my request's bench list (first appearance: cannot be Terastallized yet).
// typeOverride / transformedInto are NOT copied: they reset when a Pokémon leaves the field.
// Returns null if the species cannot be found, and the caller skips the moment.
function incomingMon(battle, ti, side, name) {
  for (let j = ti - 1; j >= 0; j--) {
    const t = battle.turns[j];
    for (const snap of [t.end && t.end[side], t.start && t.start[side]]) {
      if (snap && snap.name === name) {
        return { species: snap.species, terastallized: snap.terastallized, teraType: snap.teraType, typeOverride: null, transformedInto: null };
      }
    }
  }
  const turn = battle.turns[ti];
  let species = null;
  if (turn.end && turn.end[side] && turn.end[side].name === name) species = turn.end[side].species;
  else if (turn.available) {
    const opt = turn.available.switchOptions.find((o) => o.name === name);
    if (opt) species = opt.species;
  }
  if (!species) return null;
  return { species, terastallized: false, teraType: null, typeOverride: null, transformedInto: null };
}

// ---------------------------------------------------------------------------
// "Could the player have known?" wording
// ---------------------------------------------------------------------------

function inPlayText(battle, ti, opp, oppStart) {
  const n = entryTurn(battle, ti, opp, oppStart.name);
  if (n === null) return `${oppStart.name} was already in play`;
  return n === 0 ? `${oppStart.name} had been in play since the start of the battle` : `${oppStart.name} had been in play since turn ${n}`;
}

// For move-into-immunity: why the target's typing was visible when the player chose.
function whyTypingVisible(battle, ti, opp, oppStart) {
  // Stellar keeps the original types, so "Terastallized into Stellar" would explain nothing.
  if (oppStart.terastallized && oppStart.teraType && oppStart.teraType !== 'Stellar') {
    const n = teraTurn(battle, ti, opp, oppStart.name);
    return n === null
      ? `${oppStart.name} had already Terastallized into ${oppStart.teraType}`
      : `${oppStart.name} had Terastallized into ${oppStart.teraType} on turn ${n}`;
  }
  const base = inPlayText(battle, ti, opp, oppStart);
  return oppStart.terastallized ? base : `${base} and had not Terastallized`;
}

// For the switch rules: why the opponent's move was predictable. Either it had already been
// used (revealed), or it matches one of the opponent's own types (a beginner should expect
// a Ground type to carry a Ground move). Returns null if neither holds.
function whyMoveKnowable(battle, ti, opp, oppStart, moveName, moveType, oppTypes) {
  const revealed = oppStart.revealedMoves.includes(moveName);
  const stab = oppTypes.includes(moveType);
  if (!revealed && !stab) return null;
  let used = '';
  if (revealed) {
    const n = firstUseTurn(battle, ti, opp, oppStart.name, moveName);
    used = n === null ? `had already used ${moveName}` : `had already used ${moveName} on turn ${n}`;
  }
  if (revealed && stab) return `${oppStart.name} is a ${moveType} type and ${used}`;
  if (revealed) return `${oppStart.name} ${used}`;
  return `${oppStart.name} is a ${moveType} type and ${moveName} is a ${moveType} move`;
}

// ---------------------------------------------------------------------------
// Rule 1: move-into-immunity
// ---------------------------------------------------------------------------

function moveIntoImmunity(ctx, ti) {
  const { battle, cfg, gen, me, opp } = ctx;
  const turn = battle.turns[ti];
  const oppStart = turn.start[opp];
  const out = [];
  if (!oppStart) return out;

  for (const mv of turn.moves) {
    if (mv.side !== me || mv.missed || mv.source) continue; // source: called by Sleep Talk etc., not chosen
    if (mv.effectiveness !== 'immune' || mv.immuneBy) continue; // ability immunities are not judged
    if (cfg.situationalTypeMoves.includes(mv.move)) continue;
    // The target must be who was on the field when the player chose; if the opponent switched
    // in this turn, the player chose against a different Pokémon.
    if (!mv.target || mv.target.side !== opp || mv.target.mon !== oppStart.name) continue;

    const move = getMove(gen, mv.move);
    const oppTypes = currentTypes(gen, oppStart); // turn.start: a Tera this very turn is not included
    if (!move || !oppTypes) continue;
    // The log said "immune" AND the data agrees from the turn-start types. A same-turn Tera
    // changes the types, so the data says 1 or more and we skip it (the Close Combat case).
    if (typeMultiplier(gen, move.type, oppTypes) !== 0) continue;

    out.push({
      seq: mv.seq,
      moment: {
        turn: turn.turn, rule: 'move-into-immunity', label: cfg.labels.moveIntoImmunity,
        mon: mv.mon, title: 'Used a move the target is immune to', explanation: null,
        facts: {
          myMon: mv.mon, myMove: mv.move, myMoveType: move.type,
          oppMon: oppStart.name, oppTypes,
          multiplier: 0, effectiveness: 'immune', damagePct: mv.damagePct,
          knowable: true, whyKnowable: whyTypingVisible(battle, ti, opp, oppStart),
        },
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rules 2 and 3: switching into a hit
// ---------------------------------------------------------------------------

// A switch I chose. After a faint the replacement also shows up as a plain `switch`, and
// pivots (U-turn, Parting Shot) too, so `forced`/`source` alone are not enough: a chosen
// switch is carried out before any move or faint in the turn.
function chosenSwitches(turn, me) {
  const firstAct = turn.events.find((e) => e.type === 'move' || e.type === 'faint');
  const cut = firstAct ? firstAct.seq : Infinity;
  return turn.switches.filter((s) => s.side === me && s.type === 'switch' && !s.forced && !s.source && s.seq < cut);
}

function switchRules(ctx, ti) {
  const { battle, cfg, gen, me, opp } = ctx;
  const turn = battle.turns[ti];
  const oppStart = turn.start[opp];
  const out = [];
  if (!oppStart) return out;

  for (const sw of chosenSwitches(turn, me)) {
    // Only the FIRST opposing move aimed at my incoming Pokémon counts. If it was a normal hit
    // there is nothing to flag.
    const hit = turn.moves.find((m) => m.side === opp && m.seq > sw.seq && m.target && m.target.side === me && m.target.mon === sw.mon);
    if (!hit || hit.missed || hit.failed || hit.source) continue;
    if (hit.mon !== oppStart.name) continue; // the opponent switched in this turn: unknowable
    if (cfg.situationalTypeMoves.includes(hit.move)) continue;

    const isImmune = hit.effectiveness === 'immune' && !hit.immuneBy;
    const isSuper = hit.effectiveness === 'super';
    if (!isImmune && !isSuper) continue;

    const move = getMove(gen, hit.move);
    const oppTypes = currentTypes(gen, oppStart);
    const inc = incomingMon(battle, ti, me, sw.mon);
    const myTypes = inc && currentTypes(gen, inc);
    if (!move || !oppTypes || !myTypes) continue;

    // The log and the data must agree, otherwise something (a changed move type, an ability)
    // is going on that we do not model, and we say nothing.
    const multiplier = typeMultiplier(gen, move.type, myTypes);
    if (isImmune ? multiplier !== 0 : !(multiplier >= 2)) continue;

    const why = whyMoveKnowable(battle, ti, opp, oppStart, hit.move, move.type, oppTypes);
    if (!why) continue;

    const common = { myMon: sw.mon, myTypes, switchedOut: sw.from, oppMon: oppStart.name, oppTypes, oppMove: hit.move, oppMoveType: move.type, multiplier };

    if (isImmune) {
      out.push({
        seq: sw.seq,
        moment: {
          turn: turn.turn, rule: 'switched-into-immunity', label: cfg.labels.switchedIntoImmunity,
          mon: sw.mon, title: 'Switched into a hit it is immune to', explanation: null,
          facts: { ...common, effectiveness: 'immune', damagePct: hit.damagePct, knowable: true, whyKnowable: why },
        },
      });
      continue;
    }

    let label = null;
    if (hit.knockedOut || hit.damagePct >= cfg.blunderDamagePct) label = 'blunder';
    else if (hit.damagePct >= cfg.mistakeDamagePct) label = 'mistake';
    if (!label) continue;
    out.push({
      seq: sw.seq,
      moment: {
        turn: turn.turn, rule: 'switched-into-super-effective', label,
        mon: sw.mon, title: 'Switched into a super-effective hit', explanation: null,
        facts: {
          ...common, damagePct: hit.damagePct, hpBefore: hit.hpBefore, hpAfter: hit.hpAfter,
          knockedOut: hit.knockedOut, knowable: true, whyKnowable: why,
        },
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function buildReview(battle, { room = null, config } = {}) {
  const cfg = { ...CONFIG, ...config, labels: { ...CONFIG.labels, ...(config && config.labels) } };
  const me = battle.me;
  const r = battle.result;
  const review = {
    version: 1,
    room,
    players: { me: null, opponent: null },
    result: { won: null, forfeit: !!r.forfeit, lastTurn: r.lastTurn },
    aiUsed: false,
    summary: null,
    moments: [],
  };
  // A spectated log has no "player" to judge. A missing generation means no lookups are possible.
  if (me !== 'p1' && me !== 'p2') return review;

  const opp = otherSide(me);
  review.players = {
    me: (battle.players[me] && battle.players[me].name) || null,
    opponent: (battle.players[opp] && battle.players[opp].name) || null,
  };
  if (r.winnerSide === 'p1' || r.winnerSide === 'p2') review.result.won = r.winnerSide === me;

  if (!Number.isInteger(battle.gen)) return review;
  const ctx = { battle, cfg, gen: battle.gen, me, opp };

  const found = [];
  // Turn 0 is the lead-in (the first switch-ins): nothing was decided there.
  for (let ti = 1; ti < battle.turns.length; ti++) {
    if (!battle.turns[ti].start) continue;
    found.push(...moveIntoImmunity(ctx, ti), ...switchRules(ctx, ti));
  }
  // Turns are already in order; seq orders moments within a turn.
  found.sort((a, b) => a.moment.turn - b.moment.turn || a.seq - b.seq);
  review.moments = found.map((f) => f.moment);
  return review;
}

module.exports = { buildReview, CONFIG };
