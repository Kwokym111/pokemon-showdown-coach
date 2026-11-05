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
//   missed-ko                     another available move surely KOs, I used a different attack -> mistake
//   weak-move-choice              my attack did far less than another available one   -> mistake / blunder
//   found-the-ko                  I knocked it out and no other available move could   -> good
//   good-tera                     I Terastallized into a type that resisted the hit    -> good / great
//   bad-tera                      I Terastallized into a type weak to the hit and it landed hard -> mistake / blunder
//   move-failed                   my move could only fail (already in effect / statused) -> mistake
//   bad-replacement               my replacement (after a faint / pivot) was weak to the obvious hit -> mistake / blunder
//   low-hp-switch-in              I brought in a low-HP Pokémon and it fell before it moved -> mistake
//   ko-streak                     one Pokémon got 3+ knockouts in one stay (2+ if the opponent then forfeited, or if the last one won the game) -> great
//   setup-paid-off                a setup move that worked, then 2+ knockouts by the same Pokémon in the same stay -> good
//                                 (if that stay is already a ko-streak, the streak says so instead: setUpFirst)
//   risky-switch                  I switched into a move it was weak to that the opponent had already shown -> mistake
// The three move-choice rules before them compare my choice with my other options using damage estimates
// (damage.js, Random Battle spreads). They only use what the player could see at the start
// of the turn, treat the opponent's unknown ability as the worst case, keep a safety margin
// for its unknown item, and say nothing when the estimate is unavailable.
//
// A moment is only emitted when the player COULD HAVE KNOWN what would happen when they
// chose. Both players pick at the start of a turn, so anything that changes during the
// turn (the opponent switching in, Terastallizing) is not held against the player.
//
// After the rules run, each moment also gets `options` (the moves and bench the player had on
// that decision). It is display-only: see optionsFor() further down.
//
// Every Pokémon fact comes from data.js with the battle's generation. Anything data.js
// does not know (it returns null) means "skip this moment", never a guess.

const { getMove, typeMultiplier, currentTypes } = require('./data');
const { estimateRange, estimateDamage } = require('./damage');

// Every number and list that tunes the rules lives here.
const CONFIG = {
  // switched-into-super-effective: share of max HP the incoming Pokémon lost.
  blunderDamagePct: 50, // this much, or a knock-out, is a blunder
  mistakeDamagePct: 25, // this much is a mistake; less than this is not worth flagging
  labels: {
    moveIntoImmunity: 'mistake', switchedIntoImmunity: 'great', missedKo: 'mistake', weakMoveChoice: 'mistake', foundTheKo: 'good',
    // low-hp-switch-in cannot tell a deliberate sacrifice from a mistake, so the label is tunable.
    lowHpSwitchIn: 'mistake', moveFailed: 'mistake', goodTera: 'good', greatTera: 'great', koStreak: 'great',
    // risky-switch is never a blunder: nothing actually hit, so it only judges the risk taken.
    riskySwitch: 'mistake',
    setupPaidOff: 'good',
  },

  // low-hp-switch-in: a switch-in at or below this share of max HP counts as "low", and a
  // different bench option at or above the other share must have existed (otherwise it may
  // have been the only sensible choice).
  lowHpSwitchPct: 30,
  healthyOptionPct: 50,

  // ko-streak: knockouts by one Pokémon in one stay on the field.
  koStreakMin: 3,
  // If the opponent forfeits while that Pokémon is still in, the game was cut short by the
  // forfeit, so a shorter streak counts.
  koStreakMinBeforeForfeit: 2,
  // Same idea when I won and the stay's last knockout was the battle's final one: the game
  // ended, so the streak could not have gone on.
  koStreakMinAtGameEnd: 2,

  // setup-paid-off: after a setup move that worked, the same stay must get this many knockouts.
  setupPaidOffMinKos: 2,
  // Only boosts to these stats count as "setting up" (Calm Mind's +SpD alone would not, but its +SpA does).
  setupStats: ['atk', 'spa', 'spe'],
  // Setup moves the dex data cannot describe (Belly Drum has no `boosts` entry). Any boost to a
  // setupStats stat after them counts. (A move list, not a type chart.)
  extraSetupMoves: ['Belly Drum'],

  // risky-switch: the revealed move must hit my incoming Pokémon at least this hard, and the
  // opponent must have been able to attack (not asleep or frozen at the start of the turn).
  riskySwitchMinMultiplier: 2,
  riskySwitchSkipStatuses: ['slp', 'frz'],

  // good-tera: the hit must have been at least neutral for the old types and at most resisted
  // for the Tera type; "great" when the old types were weak to it.
  teraOldMultiplierMin: 1,
  teraNewMultiplierMax: 0.5,
  teraGreatOldMultiplier: 2,
  // bad-tera: the old types must have taken at most this much from the hit (so the Tera made it worse).
  badTeraOldMultiplierMax: 1,

  // move-failed (a): moves that fail when they are already in effect. (A move list, not a type chart.)
  repeatFailMoves: [
    'Leech Seed', 'Substitute', 'Stealth Rock', 'Sticky Web', 'Reflect', 'Light Screen',
    'Aurora Veil', 'Tailwind', 'Taunt', 'Yawn',
  ],

  // Move-choice rules (missed-ko, weak-move-choice, found-the-ko). All percentages are of the
  // opponent's MAX HP, like damage.js.
  koMarginPct: 10, // "surely KOs" must beat its HP by this much (covers its unknown item, e.g. Assault Vest)
  minAccuracy: 90, // a better move less accurate than this is not a fair recommendation
  weakGapPct: 30, // the better move must deal this many points more than the one used...
  weakRatio: 0.5, // ...and the one used must deal less than this share of it
  weakBlunderGapPct: 60, // a gap this big is a blunder instead of a mistake
  // Moves that only work in a situation the log cannot tell us, so they are never offered as
  // the "better" move and never judged when the player chose them. (A move list, not a type chart.)
  conditionalMoves: [
    'Fake Out', 'First Impression', 'Sucker Punch', 'Thunderclap', 'Upper Hand', 'Dream Eater',
    'Last Resort', 'Belch', 'Focus Punch', 'Poltergeist', 'Steel Roller', 'Snore', 'Counter',
    'Mirror Coat', 'Metal Burst', 'Bide', 'Endeavor', 'Final Gambit', 'Hidden Power', 'Return',
    'Frustration', 'Natural Gift', 'Fling', 'Present', 'Magnitude', 'Metronome', 'Mirror Move',
    'Me First', 'Copycat', 'Sleep Talk', 'Spit Up', 'Synchronoise',
  ],
  // Moves whose real type depends on the situation. data.js only knows their base type, so
  // we never judge a type matchup that rests on one of them. (A move list, not a type chart.)
  situationalTypeMoves: [
    'Tera Blast', 'Weather Ball', 'Hidden Power', 'Judgment', 'Revelation Dance',
    'Terrain Pulse', 'Multi-Attack', 'Natural Gift', 'Techno Blast', 'Raging Bull',
    'Ivy Cudgel', 'Aura Wheel', 'Tera Starstorm',
  ],

  // bad-replacement: items (Showdown ids) that make taking a super-effective hit a deliberate
  // play, as long as the holder survives the hit. Weakness Policy gives +2 Atk and +2 SpA.
  deliberateReplacementItems: ['weaknesspolicy'],
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
// With `byTypeOnly`, a move that was NOT revealed yet is described by its type alone, so the
// text never names a move the player had not seen.
function whyMoveKnowable(battle, ti, opp, oppStart, moveName, moveType, oppTypes, { byTypeOnly = false } = {}) {
  const revealed = oppStart.revealedMoves.includes(moveName);
  const stab = oppTypes.includes(moveType);
  if (!revealed && !stab) return null;
  if (!revealed && byTypeOnly) return `${oppStart.name} is a ${moveType} type, so a ${moveType} move was likely`;
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
// Rules 4 to 6: comparing the move I chose with my other options
// ---------------------------------------------------------------------------

const toId = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// A move that commits you to something or only works in the right situation. It is neither
// offered as the better option nor judged when the player picked it.
const isSpecial = (d, cfg) => d.charge || d.recharge || d.selfDestruct || cfg.conditionalMoves.includes(d.name);
const isAccurate = (d, cfg) => d.accuracy === true || d.accuracy >= cfg.minAccuracy;
const accuracyOf = (d) => (d.accuracy === true ? 100 : d.accuracy);

// What the player chose and what they could have chosen, with damage ranges against the
// opponent as it was at the START of the turn. null when the turn cannot be judged.
function moveChoice(ctx, ti) {
  const { battle, cfg, gen, me, opp } = ctx;
  const turn = battle.turns[ti];
  const mine = turn.start[me];
  const theirs = turn.start[opp];
  if (!mine || !theirs || !turn.available || !mine.moveset) return null;
  if (typeof theirs.hpPct !== 'number' || theirs.hpPct <= 0) return null;

  // The first move I used that was not called by another move. No move (a switch, a flinch,
  // knocked out first) means nothing to judge here.
  const chosen = turn.moves.find((m) => m.side === me && !m.source);
  if (!chosen || chosen.mon !== mine.name || chosen.failed || chosen.effectiveness === 'immune') return null;
  // The opponent switched in this turn: the player chose against a different Pokémon.
  if (!chosen.target || chosen.target.side !== opp || chosen.target.mon !== theirs.name) return null;

  const oppTypes = currentTypes(gen, theirs);
  if (!oppTypes) return null;

  // Terastallizing before the move changes my own damage for every option.
  const tera = turn.teras.find((t) => t.side === me && t.mon === mine.name && t.seq < chosen.seq);
  const attacker = tera ? { ...mine, terastallized: true, teraType: tera.teraType } : mine;

  const options = [];
  for (const m of turn.available.moves) {
    if (m.disabled || m.pp === 0) continue;
    const data = getMove(gen, m.name);
    if (!data || data.category === 'Status') continue;
    const est = estimateRange(gen, attacker, theirs, m.name, { field: turn.field });
    if (est) options.push({ name: data.name, data, est });
  }
  const chosenOpt = options.find((o) => toId(o.name) === toId(chosen.move));
  if (!chosenOpt) return null; // a status move, or one the estimate cannot handle: not judged
  return { turn, chosen, chosenOpt, others: options.filter((o) => o !== chosenOpt), theirs, oppTypes, hp: theirs.hpPct, cfg };
}

function moveChoiceRules(ctx, ti) {
  const c = moveChoice(ctx, ti);
  if (!c) return [];
  const { cfg, turn, chosen, chosenOpt, others, theirs, oppTypes, hp } = c;
  const oppFacts = { oppMon: theirs.name, oppTypes, oppHpPct: hp };
  const mineFacts = { myMon: chosen.mon, myMove: chosenOpt.name, myMoveMinPct: chosenOpt.est.minPct, myMoveMaxPct: chosenOpt.est.maxPct };

  // 6. found-the-ko: I knocked it out, and no other move I had could have.
  if (chosen.knockedOut) {
    if (others.length === 0 || !others.every((o) => o.est.maxPct + cfg.koMarginPct < hp)) return [];
    const bestOther = others.reduce((b, o) => (o.est.maxPct > b.est.maxPct ? o : b));
    return [{
      seq: chosen.seq,
      moment: {
        turn: turn.turn, rule: 'found-the-ko', label: cfg.labels.foundTheKo, mon: chosen.mon, title: 'Found the knockout', explanation: null,
        facts: {
          ...mineFacts, bestOtherMove: bestOther.name, bestOtherMaxPct: bestOther.est.maxPct, ...oppFacts, knowable: true,
          whyKnowable: `${theirs.name} was at ${hp}% HP, ${chosenOpt.name} does ${chosenOpt.est.minPct}-${chosenOpt.est.maxPct}% to it, and none of your other moves could do enough`,
        },
      },
    }];
  }

  // A deliberate choice is never second-guessed: pivots, priority, charge/recharge/self-KO and
  // situational moves.
  const d = chosenOpt.data;
  if (d.selfSwitch || d.priority > 0 || isSpecial(d, cfg)) return [];

  const moment = (rule, label, title, better, why) => ({
    seq: chosen.seq,
    moment: {
      turn: turn.turn, rule, label, mon: chosen.mon, title, explanation: null,
      facts: {
        ...mineFacts, betterMove: better.name, betterMoveMinPct: better.est.minPct, betterMoveMaxPct: better.est.maxPct,
        ...oppFacts, oppAbilityKnown: better.est.oppAbilityKnown, knowable: true, whyKnowable: why,
      },
    },
  });
  // Only worth saying when the ability really was uncertain (more than one it could have).
  const abilityText = (o) => (o.est.oppAbilityKnown || o.est.abilitiesTried.length < 2 ? '' : ' whichever ability it has');

  // 4. missed-ko: another move surely knocks it out (with a margin), and I did not.
  if (!chosenOpt.est.guaranteedKo) {
    const kos = others.filter((o) => !isSpecial(o.data, cfg) && isAccurate(o.data, cfg) && o.est.guaranteedKo && o.est.minPct >= hp + cfg.koMarginPct);
    if (kos.length) {
      const best = kos.reduce((b, o) => (accuracyOf(o.data) > accuracyOf(b.data) || (accuracyOf(o.data) === accuracyOf(b.data) && o.est.minPct > b.est.minPct) ? o : b));
      return [moment('missed-ko', cfg.labels.missedKo, 'Missed a knockout', best,
        `${theirs.name} was at ${hp}% HP and ${best.name} does ${best.est.minPct}-${best.est.maxPct}% to it${abilityText(best)}, enough to knock it out; it was one of your available moves`)];
    }
  }

  // 5. weak-move-choice: another clean, accurate move does far more. Damage beyond the
  // opponent's remaining HP does not count, so a 30% move and a 90% move into a 10% target are equal.
  const clean = others.filter((o) => !isSpecial(o.data, cfg) && !o.data.lockedMove && !o.data.selfDebuff && isAccurate(o.data, cfg));
  if (!clean.length) return [];
  const best = clean.reduce((b, o) => (Math.min(o.est.minPct, hp) > Math.min(b.est.minPct, hp) ? o : b));
  const bestCap = Math.min(best.est.minPct, hp);
  const chosenCap = Math.min(chosenOpt.est.maxPct, hp);
  const gap = bestCap - chosenCap;
  if (gap < cfg.weakGapPct || chosenCap >= cfg.weakRatio * bestCap) return [];
  return [moment('weak-move-choice', gap >= cfg.weakBlunderGapPct ? 'blunder' : cfg.labels.weakMoveChoice, 'Used a much weaker move than another option', best,
    `${theirs.name} was at ${hp}% HP; ${best.name} does ${best.est.minPct}-${best.est.maxPct}% to it${abilityText(best)} but ${chosenOpt.name} only ${chosenOpt.est.minPct}-${chosenOpt.est.maxPct}%, and both were available`)];
}

// ---------------------------------------------------------------------------
// Rules 7 and 7b: good-tera, bad-tera
// ---------------------------------------------------------------------------

// What my Terastallization this turn ran into: the opponent's FIRST damaging move aimed at
// that Pokémon, if it came after the Tera and could have been foreseen. Shared by good-tera
// and bad-tera; each rule then decides whether the matchup got better or worse.
// Returns one entry per qualifying Tera: { tera, hit, move, oppStart, oldTypes, oldMultiplier, newMultiplier, why }.
function teraSituations(ctx, ti) {
  const { battle, cfg, gen, me, opp } = ctx;
  const turn = battle.turns[ti];
  const mineStart = turn.start[me];
  const oppStart = turn.start[opp];
  const out = [];
  if (!mineStart || !oppStart) return out;

  for (const tera of turn.teras) {
    if (tera.side !== me || tera.mon !== mineStart.name || !tera.teraType || tera.teraType === 'Stellar') continue;
    if (mineStart.terastallized) continue;

    // If the opponent was faster, its move hit before the Tera happened and the Tera cannot
    // take credit or blame for anything, so we stop there.
    let hit = null;
    let unknown = false;
    for (const m of turn.moves) {
      if (m.side !== opp || !m.target || m.target.side !== me || m.target.mon !== mineStart.name) continue;
      const d = getMove(gen, m.move);
      if (!d) { unknown = true; break; }
      if (d.category === 'Status') continue;
      hit = m;
      break;
    }
    if (unknown || !hit || hit.seq < tera.seq) continue;
    if (hit.missed || hit.failed || hit.source || hit.mon !== oppStart.name) continue; // misses are luck; a switch-in is unknowable
    if (cfg.situationalTypeMoves.includes(hit.move)) continue;

    const move = getMove(gen, hit.move);
    const oppTypes = currentTypes(gen, oppStart);
    const oldTypes = currentTypes(gen, mineStart); // turn.start: before this Tera
    if (!move || !oppTypes || !oldTypes) continue;
    const oldMultiplier = typeMultiplier(gen, move.type, oldTypes);
    const newMultiplier = typeMultiplier(gen, move.type, [tera.teraType]);
    if (oldMultiplier === null || newMultiplier === null) continue;
    const why = whyMoveKnowable(battle, ti, opp, oppStart, hit.move, move.type, oppTypes);
    if (!why) continue;
    out.push({ tera, hit, move, oppStart, oldTypes, oldMultiplier, newMultiplier, why });
  }
  return out;
}

function goodTera(ctx, ti) {
  const { battle, cfg } = ctx;
  const turn = battle.turns[ti];
  const out = [];
  for (const s of teraSituations(ctx, ti)) {
    const { tera, hit, move, oppStart, oldTypes, oldMultiplier, newMultiplier } = s;
    if (hit.effectiveness !== 'resisted' && !(hit.effectiveness === 'immune' && !hit.immuneBy)) continue;
    if (oldMultiplier < cfg.teraOldMultiplierMin || newMultiplier > cfg.teraNewMultiplierMax) continue;
    // The log and the data must agree (resisted means below 1, immune means 0).
    if (hit.effectiveness === 'immune' ? newMultiplier !== 0 : newMultiplier === 0) continue;

    const great = oldMultiplier >= cfg.teraGreatOldMultiplier;
    out.push({
      seq: tera.seq,
      moment: {
        turn: turn.turn, rule: 'good-tera', label: great ? cfg.labels.greatTera : cfg.labels.goodTera,
        mon: tera.mon, title: 'Terastallized into a type that resisted the hit', explanation: null,
        facts: {
          myMon: tera.mon, oldTypes, teraType: tera.teraType,
          oppMon: oppStart.name, oppMove: hit.move, oppMoveType: move.type,
          oldMultiplier, newMultiplier, damagePct: hit.damagePct,
          knowable: true, whyKnowable: s.why,
        },
      },
    });
  }
  return out;
}

// The mirror of good-tera: I Terastallized into a type that is weak to a hit the opponent was
// likely to make, and it landed hard. A Tera is optional, so there is no "better option" check;
// the damage thresholds (shared with the switch rules) keep small hits out. The old types must
// NOT already have been weak to it, otherwise the Tera did not make anything worse. Caveat: the
// player may have Terastallized to power up an attack, which the log cannot show.
function badTera(ctx, ti) {
  const { battle, cfg } = ctx;
  const turn = battle.turns[ti];
  const out = [];
  for (const s of teraSituations(ctx, ti)) {
    const { tera, hit, move, oppStart, oldTypes, oldMultiplier, newMultiplier } = s;
    if (hit.effectiveness !== 'super') continue;
    if (newMultiplier < 2 || oldMultiplier > cfg.badTeraOldMultiplierMax) continue; // log and data must agree
    let label = null;
    if (hit.knockedOut || hit.damagePct >= cfg.blunderDamagePct) label = 'blunder';
    else if (hit.damagePct >= cfg.mistakeDamagePct) label = 'mistake';
    if (!label) continue;

    out.push({
      seq: tera.seq,
      moment: {
        turn: turn.turn, rule: 'bad-tera', label,
        mon: tera.mon, title: 'Terastallized into a type that was weak to the hit', explanation: null,
        facts: {
          myMon: tera.mon, oldTypes, teraType: tera.teraType,
          oppMon: oppStart.name, oppMove: hit.move, oppMoveType: move.type,
          oldMultiplier, newMultiplier, damagePct: hit.damagePct, knockedOut: hit.knockedOut,
          knowable: true, whyKnowable: s.why,
        },
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 8: move-failed
// ---------------------------------------------------------------------------

const STATUS_WORDS = { par: 'paralyzed', brn: 'burned', psn: 'poisoned', tox: 'badly poisoned', slp: 'asleep', frz: 'frozen' };

// For "already in effect": the turn and seq of the latest SUCCESSFUL use of `move` by this
// Pokémon before turn `ti`, or null if there is none or something ended / moved it since.
// Neither Pokémon may have left the field in between, and no `-end` / `-sideend` line may
// name the move (that would mean the effect was over and the failure has another cause).
function stillActiveSince(battle, ti, me, opp, name, oppName, moveName) {
  let found = null;
  for (let j = ti - 1; j >= 1 && !found; j--) {
    for (const m of battle.turns[j].moves) {
      if (m.side === me && m.mon === name && m.move === moveName && !m.failed && !m.missed && !m.source) found = { j, seq: m.seq };
    }
  }
  if (!found) return null;
  const moveText = (a) => typeof a === 'string' && a.replace(/^move: /, '') === moveName;
  for (let j = found.j; j <= ti; j++) {
    const t = battle.turns[j];
    for (const e of t.events) {
      if (j === found.j && e.seq <= found.seq) continue;
      if ((e.type === 'switch' || e.type === 'drag') && (e.side === me || e.side === opp)) return null;
      if ((e.type === 'end' || e.type === 'sideend') && Array.isArray(e.args) && e.args.some(moveText)) return null;
    }
  }
  return found.j;
}

function moveFailed(ctx, ti) {
  const { battle, cfg, gen, me, opp } = ctx;
  const turn = battle.turns[ti];
  const mine = turn.start[me];
  const oppStart = turn.start[opp];
  const out = [];
  if (!mine || !oppStart) return out;

  for (const mv of turn.moves) {
    // A miss, a Sleep Talk call or anything else not chosen is not judged. (`mv.target` is
    // empty on a failed move, so the target is whoever the opponent had out at turn start.)
    if (mv.side !== me || !mv.failed || mv.missed || mv.source || mv.mon !== mine.name) continue;
    if (turn.switches.some((s) => s.side === opp && s.seq < mv.seq)) continue; // chose against a different Pokémon
    const move = getMove(gen, mv.move);
    if (!move) continue;

    let reason = null;
    let since = null;
    let why = null;
    const inPlay = inPlayText(battle, ti, opp, oppStart);

    if (cfg.repeatFailMoves.includes(mv.move)) {
      const j = stillActiveSince(battle, ti, me, opp, mine.name, oppStart.name, mv.move);
      if (j !== null) {
        reason = 'already-active';
        since = j;
        why = `${mine.name} had already used ${mv.move} successfully on turn ${j}, and neither ${mine.name} nor ${oppStart.name} had left the field since`;
      }
    } else if (move.category === 'Status' && move.status && oppStart.status) {
      // A named target, if the line has one, must be the Pokémon that was out at turn start.
      if (mv.target && (mv.target.side !== opp || mv.target.mon !== oppStart.name)) continue;
      reason = 'already-statused';
      since = oppStart.status;
      why = `${inPlay} and was already ${STATUS_WORDS[oppStart.status] || oppStart.status} at the start of the turn`;
    }
    if (!reason) continue;

    out.push({
      seq: mv.seq,
      moment: {
        turn: turn.turn, rule: 'move-failed', label: cfg.labels.moveFailed,
        mon: mv.mon, title: 'Used a move that could only fail', explanation: null,
        facts: {
          myMon: mv.mon, myMove: mv.move, oppMon: oppStart.name, reason, since,
          knowable: true, whyKnowable: why,
        },
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rules 9 and 10: replacements (bad-replacement, low-hp-switch-in)
// ---------------------------------------------------------------------------

// My switch-ins in a turn that I did NOT choose at the start of it: after one of my Pokémon
// fainted, or after my own pivot (U-turn, Volt Switch...). Each comes with the bench I could
// pick from (the |request| the game sent me). Item-triggered exits (Eject Button) and
// Roar/Whirlwind drags are not my decision, so they are left out. Two replacements in one
// turn would share one request list, so such a turn is not judged.
function replacementsOf(ctx, ti) {
  const { battle, gen, me } = ctx;
  const turn = battle.turns[ti];
  if (!turn.forceSwitch) return [];
  const mine = turn.switches.filter((s) => s.side === me && s.type === 'switch' && !s.forced && !chosenSwitches(turn, me).includes(s));
  if (mine.length !== 1) return [];
  const sw = mine[0];
  const options = turn.forceSwitch.switchOptions.filter((o) => o.name !== sw.mon);

  if (!sw.source && sw.from && turn.faints.some((f) => f.side === me && f.mon === sw.from && f.seq < sw.seq)) {
    return [{ sw, replacedAfter: 'faint', options }];
  }
  const pivot = sw.source && getMove(gen, sw.source);
  if (pivot && pivot.selfSwitch) return [{ sw, replacedAfter: pivot.name, options }];
  return [];
}

const aimedAt = (m, side, name) => !!m.target && m.target.side === side && m.target.mon === name;

// Shared by bad-replacement and risky-switch: the bench Pokémon that would have taken a move of
// `moveType` at 1x or less. With `minHpPct`, options below that HP are not a fair suggestion.
// Returns { name, multiplier, hpPct } or null.
function saferOption(ctx, ti, options, moveType, { minHpPct = null } = {}) {
  const { battle, gen, me } = ctx;
  let safer = null;
  for (const o of options) {
    if (minHpPct !== null && !(typeof o.hpPct === 'number' && o.hpPct >= minHpPct)) continue;
    const mon = incomingMon(battle, ti, me, o.name) || { species: o.species, terastallized: false, teraType: null, typeOverride: null, transformedInto: null };
    const types = currentTypes(gen, mon);
    const mult = types && typeMultiplier(gen, moveType, types);
    if (mult === null || mult === undefined || mult > 1) continue;
    // Name the healthiest safe option (a 25% HP Pokémon is a poor thing to recommend), then the safest matchup.
    if (!safer || o.hpPct > safer.hpPct || (o.hpPct === safer.hpPct && mult < safer.multiplier)) safer = { name: o.name, multiplier: mult, hpPct: o.hpPct };
  }
  return safer;
}

function badReplacement(ctx, ti) {
  const { battle, cfg, gen, me, opp } = ctx;
  const turn = battle.turns[ti];
  const out = [];

  for (const { sw, replacedAfter, options } of replacementsOf(ctx, ti)) {
    // Who the opponent had out when I picked. After a faint I pick at the end of the turn; after
    // a pivot I pick mid-turn, and a switch or faint on their side would make that unclear.
    if (turn.faints.some((f) => f.side === opp)) continue;
    if (replacedAfter !== 'faint' && turn.switches.some((s) => s.side === opp)) continue;
    const oppAtPick = replacedAfter === 'faint' ? turn.end && turn.end[opp] : turn.start[opp];
    if (!oppAtPick) continue;

    // The first opposing move aimed at the replacement: later in this turn (pivot), else next turn.
    let hit = turn.moves.find((m) => m.side === opp && m.seq > sw.seq && aimedAt(m, me, sw.mon));
    let hitTi = ti;
    if (!hit) {
      const next = battle.turns[ti + 1];
      if (!next || !next.start || !next.start[opp] || next.start[opp].name !== oppAtPick.name) continue;
      hit = next.moves.find((m) => m.side === opp && aimedAt(m, me, sw.mon));
      hitTi = ti + 1;
    }
    if (!hit || hit.missed || hit.failed || hit.source || hit.mon !== oppAtPick.name) continue;
    if (hit.effectiveness !== 'super' || cfg.situationalTypeMoves.includes(hit.move)) continue;
    // Holding e.g. Weakness Policy turns the hit into a boost, so taking it was deliberate. If the
    // hit knocked the holder out the item never gets to work, so that is still a mistake.
    const entering = turn.forceSwitch.switchOptions.find((o) => o.name === sw.mon);
    if (entering && cfg.deliberateReplacementItems.includes(entering.item) && !hit.knockedOut) continue;
    // A Tera on my side before the hit changes the types the log's "super effective" refers to.
    const hitTurn = battle.turns[hitTi];
    if (hitTurn.teras.some((t) => t.side === me && t.mon === sw.mon && t.seq < hit.seq)) continue;

    const oppSnap = hitTi === ti && replacedAfter !== 'faint' ? turn.start[opp] : turn.end[opp];
    const move = getMove(gen, hit.move);
    const oppTypes = currentTypes(gen, oppSnap);
    const inc = incomingMon(battle, ti, me, sw.mon);
    const myTypes = inc && currentTypes(gen, inc);
    if (!move || !oppTypes || !myTypes) continue;
    const multiplier = typeMultiplier(gen, move.type, myTypes);
    if (!(multiplier >= 2)) continue; // the log and the data must agree

    const why = whyMoveKnowable(battle, hitTi, opp, oppSnap, hit.move, move.type, oppTypes, { byTypeOnly: true });
    if (!why) continue;
    // The player could only have known the move itself if it was already revealed; otherwise
    // the facts carry its type only (also keeps the AI from naming a move they had not seen).
    const moveRevealed = oppSnap.revealedMoves.includes(hit.move);

    let label = null;
    if (hit.knockedOut || hit.damagePct >= cfg.blunderDamagePct) label = 'blunder';
    else if (hit.damagePct >= cfg.mistakeDamagePct) label = 'mistake';
    if (!label) continue;

    // Fairness: it is only a mistake if a bench Pokémon would have taken a normal hit or less.
    const safer = saferOption(ctx, ti, options, move.type);
    if (!safer) continue;

    out.push({
      seq: sw.seq,
      moment: {
        turn: turn.turn, rule: 'bad-replacement', label,
        mon: sw.mon, title: 'Sent in a Pokémon that was weak to the obvious hit', explanation: null,
        facts: {
          myMon: sw.mon, myTypes, replacedAfter, oppMon: oppSnap.name, oppTypes, oppMove: moveRevealed ? hit.move : null, oppMoveType: move.type,
          multiplier, damagePct: hit.damagePct, hpBefore: hit.hpBefore, hpAfter: hit.hpAfter, knockedOut: hit.knockedOut,
          hitTurn: hitTurn.turn, saferOption: { name: safer.name, multiplier: safer.multiplier },
          knowable: true, whyKnowable: why,
        },
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 12: risky-switch
// ---------------------------------------------------------------------------

// switched-into-super-effective only judges a hit that LANDS. This one covers the other case:
// I switched into a move my Pokémon was weak to, the opponent had already shown that move, and
// it simply did not come this turn (it used something else, missed, or failed). The risk was
// the same, so it is still a mistake, but never a blunder because nothing was lost.
// `switchMoments` are this turn's switched-into-* moments, so one mistake gives one moment.
function riskySwitch(ctx, ti, switchMoments) {
  const { battle, cfg, gen, me, opp } = ctx;
  const turn = battle.turns[ti];
  const oppStart = turn.start[opp];
  const out = [];
  if (!oppStart || !turn.available) return out;
  // An asleep or frozen opponent probably could not attack, so the switch was not risky.
  if (cfg.riskySwitchSkipStatuses.includes(oppStart.status)) return out;
  // If the opponent switched (or was dragged) this turn, the player may have predicted it.
  if (turn.switches.some((s) => s.side === opp)) return out;
  const oppTypes = currentTypes(gen, oppStart);
  if (!oppTypes) return out;

  for (const sw of chosenSwitches(turn, me)) {
    if (switchMoments.some((f) => f.moment.mon === sw.mon)) continue;
    const entering = turn.available.switchOptions.find((o) => o.name === sw.mon);
    const inc = incomingMon(battle, ti, me, sw.mon);
    const myTypes = inc && currentTypes(gen, inc);
    if (!entering || !myTypes) continue;
    // Weakness Policy turns the hit into a boost, so taking it would be deliberate.
    if (cfg.deliberateReplacementItems.includes(entering.item)) continue;

    // The strongest damaging move the opponent had already used (earliest on a tie). Status
    // moves, fixed-damage moves (base power 0) and situational ones are never judged. Pivot
    // moves (U-turn, Volt Switch...) are skipped too: they are usually used to get out of a bad
    // matchup, not to knock something out, so not fearing one is a reasonable read.
    let pick = null;
    for (const name of oppStart.revealedMoves) {
      const d = getMove(gen, name);
      if (!d || d.category === 'Status' || !(d.basePower > 0) || d.selfSwitch) continue;
      if (cfg.situationalTypeMoves.includes(d.name) || cfg.conditionalMoves.includes(d.name)) continue;
      const multiplier = typeMultiplier(gen, d.type, myTypes);
      if (multiplier === null || multiplier < cfg.riskySwitchMinMultiplier) continue;
      const revealedTurn = firstUseTurn(battle, ti, opp, oppStart.name, name);
      if (revealedTurn === null) continue;
      if (!pick || multiplier > pick.multiplier) pick = { name: d.name, type: d.type, multiplier, revealedTurn };
    }
    if (!pick) continue;

    // What the opponent did instead. A landed hit from that move means the log and the data
    // disagree, and a landed super-effective hit from any move is switched-into-super-effective's
    // territory even when it was too small to flag, so both say nothing here.
    const theirMoves = turn.moves.filter((m) => m.side === opp && !m.source && m.mon === oppStart.name && m.seq > sw.seq);
    const landed = (m) => !m.missed && !m.failed;
    if (theirMoves.some((m) => aimedAt(m, me, sw.mon) && landed(m) && (m.effectiveness === 'super' || m.move === pick.name))) continue;
    const used = theirMoves.find((m) => m.move === pick.name);
    const first = theirMoves[0];
    let whatHappened;
    if (used) whatHappened = `${oppStart.name} used ${pick.name} but it ${used.missed ? 'missed' : 'failed'}, so the hit did not land`;
    else if (first) whatHappened = `${oppStart.name} used ${first.move} instead${first.failed ? ', which failed' : ''}, so the hit did not come this time`;
    else whatHappened = `${oppStart.name} did not use a move this turn, so the hit did not come`;

    // Fairness: a healthy bench Pokémon must have taken a normal hit or less.
    const options = turn.available.switchOptions.filter((o) => o.name !== sw.mon);
    const safer = saferOption(ctx, ti, options, pick.type, { minHpPct: cfg.healthyOptionPct });
    if (!safer) continue;

    // Ask the damage calc about my Pokémon's real ability and item (Levitate, Volt Absorb, Air
    // Balloon...). If it says the move does nothing, the switch was fine. If it cannot answer,
    // say nothing.
    const defender = { ...inc, side: me, name: sw.mon, ability: entering.ability, item: entering.item, status: entering.status, hpPct: entering.hpPct };
    const est = estimateDamage(gen, oppStart, defender, pick.name, { field: turn.field });
    if (!est || !(est.maxPct > 0)) continue;

    const hpText = safer.hpPct >= 100 ? 'full HP' : `${safer.hpPct}% HP`;
    const takes = safer.multiplier === 0 ? 'takes no damage from it' : safer.multiplier === 1 ? 'takes normal damage' : 'takes reduced damage';
    out.push({
      seq: sw.seq,
      moment: {
        turn: turn.turn, rule: 'risky-switch', label: cfg.labels.riskySwitch,
        mon: sw.mon, title: 'Switched into a move it was weak to', explanation: null,
        facts: {
          myMon: sw.mon, myTypes, switchedOut: sw.from, oppMon: oppStart.name, oppTypes, oppMove: pick.name, oppMoveType: pick.type,
          multiplier: pick.multiplier, revealedTurn: pick.revealedTurn, whatHappened,
          saferOption: { name: safer.name, multiplier: safer.multiplier, hpPct: safer.hpPct },
          knowable: true,
          whyKnowable: `${oppStart.name} had already used ${pick.name} on turn ${pick.revealedTurn}, ${pick.type} is super-effective against ${sw.mon}'s ${myTypes.join('/')} typing, and ${safer.name} was at ${hpText} and ${takes}`,
        },
      },
    });
  }
  return out;
}

// Any switch-in of mine that was a choice: at the start of a turn, after a faint, or after a pivot.
function myChoiceSwitchIns(ctx, ti) {
  const { battle, me } = ctx;
  const turn = battle.turns[ti];
  const out = replacementsOf(ctx, ti);
  const options = turn.available ? turn.available.switchOptions : null;
  if (options) {
    for (const sw of chosenSwitches(turn, me)) out.push({ sw, replacedAfter: null, options: options.filter((o) => o.name !== sw.mon) });
  }
  return out;
}

// What happened to a Pokémon after it came in: it fainted before using a move (-> the faint
// event and the turn), or it did something else first / left alive (-> null).
function fellBeforeActing(ctx, ti, sw) {
  const { battle, me } = ctx;
  for (let j = ti; j < battle.turns.length; j++) {
    for (const e of battle.turns[j].events) {
      if (j === ti && e.seq <= sw.seq) continue;
      if (e.side !== me) continue;
      if (e.type === 'move' && e.mon === sw.mon) return null;
      if ((e.type === 'switch' || e.type === 'drag')) return null;
      if (e.type === 'faint' && e.mon === sw.mon) return { turn: battle.turns[j], faint: e };
    }
  }
  return null;
}

function lowHpSwitchIn(ctx, ti, flagged) {
  const { battle, cfg, me, opp } = ctx;
  const turn = battle.turns[ti];
  const out = [];

  for (const { sw, options } of myChoiceSwitchIns(ctx, ti)) {
    if (typeof sw.hpPct !== 'number' || sw.hpPct > cfg.lowHpSwitchPct) continue;
    if (flagged.has(`${turn.turn}|${sw.mon}`)) continue; // bad-replacement already covers this switch-in
    const healthy = options.filter((o) => typeof o.hpPct === 'number' && o.hpPct >= cfg.healthyOptionPct);
    if (!healthy.length) continue; // no good alternative, so it may have been forced
    const better = healthy.reduce((b, o) => (o.hpPct > b.hpPct ? o : b));

    const fell = fellBeforeActing(ctx, ti, sw);
    if (!fell) continue;
    // Only a knockout by an opposing move can be explained; poison, hazards and the like are not judged.
    const ko = fell.turn.moves.filter((m) => m.side === opp && m.knockedOut && aimedAt(m, me, sw.mon) && m.seq < fell.faint.seq).pop();
    if (!ko) continue;

    out.push({
      seq: sw.seq,
      moment: {
        turn: turn.turn, rule: 'low-hp-switch-in', label: cfg.labels.lowHpSwitchIn,
        mon: sw.mon, title: 'Brought in a low-HP Pokémon that fell before it could move', explanation: null,
        facts: {
          myMon: sw.mon, hpWhenEntered: sw.hpPct, faintedTurn: fell.turn.turn,
          koBy: { oppMon: ko.mon, move: ko.move }, healthierOption: { name: better.name, hpPct: better.hpPct },
          knowable: true,
          whyKnowable: `${sw.mon} came in at ${sw.hpPct}% HP while ${better.name} was at ${better.hpPct}%, and it was knocked out by ${ko.mon}'s ${ko.move} on turn ${fell.turn.turn} before it used a move`,
        },
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 11: ko-streak
// ---------------------------------------------------------------------------

// Seq restarts every turn, so "later than" needs the turn as well.
const isAfter = (a, b) => a.turn > b.turn || (a.turn === b.turn && a.seq > b.seq);

// 'p1a: Blaziken' -> { side: 'p1', mon: 'Blaziken' }. Boost events are stored as raw protocol
// arguments (no side/mon fields), so the rules read the ident themselves.
function parseIdent(ident) {
  const m = /^(p[12])[a-z]?: (.*)$/.exec(ident || '');
  return m ? { side: m[1], mon: m[2] } : null;
}

// Did my move at events[i] actually raise one of my stats? Boost lines come right after the
// move line, so we read only the unbroken run of events that follows it. Stopping at the first
// other event matters: Speed Boost (an ability, which adds no event of its own) raises Speed at
// the END of the turn, after other events, and must not be mistaken for a setup move working.
// A failed or capped setup move prints no boost line at all, so it never counts.
function setupWorked(ctx, events, i) {
  const { cfg, gen, me } = ctx;
  const e = events[i];
  const move = getMove(gen, e.move);
  if (!move) return null;
  let stats;
  if (cfg.extraSetupMoves.includes(move.name)) {
    stats = cfg.setupStats;
  } else {
    // Data-driven: a Status move aimed at myself that raises a setup stat. A damaging move
    // (Power-Up Punch, Flame Charge) keeps its boost elsewhere in the data and is not setup.
    if (move.category !== 'Status' || move.target !== 'self' || !move.boosts) return null;
    stats = cfg.setupStats.filter((s) => move.boosts[s] > 0);
  }
  if (!stats.length) return null;
  for (let j = i + 1; j < events.length; j++) {
    const f = events[j];
    if (f.type === 'damage' && f.self) continue; // Belly Drum pays HP before the boost
    if (f.type !== 'boost' && f.type !== 'setboost') break;
    const who = parseIdent(f.args && f.args[0]);
    if (who && who.side === me && who.mon === e.mon && stats.includes(f.args[1])) return { move: move.name };
  }
  return null;
}

// "a", "a and b", "a, b and c".
const joinList = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

// "Swords Dance on turns 18 and 20" / "Nasty Plot on turn 3 and Calm Mind on turn 5".
function setupText(setups) {
  const byMove = [];
  for (const s of setups) {
    let g = byMove.find((x) => x.move === s.move);
    if (!g) { g = { move: s.move, turns: [] }; byMove.push(g); }
    g.turns.push(s.turn);
  }
  return joinList(byMove.map((g) => `${g.move} on turn${g.turns.length > 1 ? 's' : ''} ${joinList(g.turns.map(String))}`));
}

// Walks the whole battle once. A "stay" starts when one of my Pokémon comes onto the field and
// ends when it is replaced or faints. Only knockouts from its own moves count (`knockedOut`
// is only set by direct move damage, never by burn, hazards or recoil). Both ko-streak and
// setup-paid-off read these stays, so they always agree on what one Pokémon did in one stay.
// Each stay: { mon, fromTurn, kos: [{ turn, oppMon, move, seq }], setups: [{ turn, move, seq }],
// endedByForfeit, endedGame }.
function myStays(ctx) {
  const { battle, me, opp } = ctx;
  const stays = [];
  let cur = null;
  const close = () => { if (cur) stays.push(cur); cur = null; };
  let lastOppFaint = null; // the battle's final opposing faint

  battle.turns.forEach((turn) => {
    turn.events.forEach((e, i, events) => {
      if (e.type === 'faint' && e.side === opp) lastOppFaint = { turn: turn.turn, seq: e.seq, mon: e.mon };
      if (e.side !== me) return;
      if (e.type === 'switch' || e.type === 'drag') { close(); cur = { mon: e.mon, fromTurn: turn.turn, kos: [], setups: [] }; }
      else if (e.type === 'faint') { if (cur && cur.mon === e.mon) close(); }
      else if (e.type === 'move' && cur && e.mon === cur.mon) {
        if (e.knockedOut && e.target) cur.kos.push({ turn: turn.turn, oppMon: e.target.mon, move: e.move, seq: e.seq });
        // A move called by another move (Sleep Talk) was not the player's choice.
        const worked = !e.source && setupWorked(ctx, events, i);
        if (worked) cur.setups.push({ turn: turn.turn, move: worked.move, seq: e.seq });
      }
    });
  });
  // A stay still open at the end never fainted or left. If the opponent forfeited, the game was
  // cut short while it was still in, so it counts with a lower bar (the forfeit stopped the streak).
  const r = battle.result;
  if (cur && r.forfeit && r.winnerSide === me) cur.endedByForfeit = true;
  close();

  // I won without a forfeit and the stay's last knockout was the battle's last: the opposing
  // Pokémon it knocked out was the final one to faint, so the opponent had nothing left.
  if (r.winnerSide === me && !r.forfeit && lastOppFaint) {
    for (const s of stays) {
      const last = s.kos[s.kos.length - 1];
      s.endedGame = !!last && last.turn === lastOppFaint.turn && last.seq < lastOppFaint.seq && last.oppMon === lastOppFaint.mon;
    }
  }
  return stays;
}

// Rules 11 and 13: ko-streak, setup-paid-off. Returns entries shaped like the other rules, plus
// `streak: { mon, kos }` (the knockouts the moment covers) so buildReview can drop the
// found-the-ko moments that are inside it.
function stayRules(ctx) {
  const { cfg } = ctx;
  const out = [];

  for (const s of myStays(ctx)) {
    // Set up, then cashed in: the knockouts that came AFTER the first working setup.
    const first = s.setups[0];
    const kosAfter = first ? s.kos.filter((k) => isAfter(k, first)) : [];
    const paidOff = kosAfter.length >= cfg.setupPaidOffMinKos;
    const lastPaid = kosAfter[kosAfter.length - 1];
    // Only the setups that came before the last counted knockout are part of the story.
    const setups = paidOff ? s.setups.filter((u) => isAfter(lastPaid, u)).map(({ turn, move }) => ({ turn, move })) : [];

    const bar = Math.min(
      s.endedByForfeit ? cfg.koStreakMinBeforeForfeit : Infinity,
      s.endedGame ? cfg.koStreakMinAtGameEnd : Infinity,
      cfg.koStreakMin,
    );
    const since = s.fromTurn === 0 ? 'the start of the battle' : `turn ${s.fromTurn}`;

    if (s.kos.length >= bar) {
      const last = s.kos[s.kos.length - 1];
      const setupBit = paidOff ? `set up with ${setupText(setups)}, ` : '';
      let why;
      if (s.endedByForfeit) {
        why = `${s.mon} stayed on the field from ${since}, ${setupBit}knocked out ${s.kos.length} opposing Pokémon, and the opponent forfeited while it was still in`;
      } else {
        why = `${s.mon} stayed on the field from ${since}${paidOff ? ', ' : ' and '}${setupBit}${paidOff ? 'and ' : ''}knocked out ${s.kos.length} opposing Pokémon with its own moves`;
        if (s.endedGame) why += ', and its last knockout won the game';
      }
      out.push({
        seq: last.seq,
        streak: s,
        moment: {
          turn: last.turn, rule: 'ko-streak', label: cfg.labels.koStreak,
          mon: s.mon, title: 'Knockout streak', explanation: null,
          facts: {
            myMon: s.mon, count: s.kos.length, kos: s.kos.map(({ turn, oppMon, move }) => ({ turn, oppMon, move })),
            endedByForfeit: !!s.endedByForfeit,
            endedGame: !!s.endedGame,
            // One moment per achievement: a streak that was set up says so here instead of
            // getting a second setup-paid-off moment.
            setUpFirst: paidOff,
            setupMoves: setups,
            knowable: true,
            whyKnowable: why,
          },
        },
      });
    } else if (paidOff) {
      const names = kosAfter.map((k) => k.oppMon);
      out.push({
        seq: lastPaid.seq,
        streak: { mon: s.mon, kos: kosAfter },
        moment: {
          turn: lastPaid.turn, rule: 'setup-paid-off', label: cfg.labels.setupPaidOff,
          mon: s.mon, title: 'Setup paid off', explanation: null,
          facts: {
            myMon: s.mon, setupMoves: setups,
            kos: kosAfter.map(({ turn, oppMon, move }) => ({ turn, oppMon, move })),
            knowable: true,
            whyKnowable: `${s.mon} used ${setupText(setups)}, then knocked out ${joinList(names)} with its own moves during the same stay on the field`,
          },
        },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// moment.options: what the player could choose on that decision (display only)
// ---------------------------------------------------------------------------

// The review screen shows these so a replay reader can see the moves and bench they had. They
// are NOT in `facts`, so the AI prompt (which sends only facts) never sees them, and they are
// not part of the cache key. No rule reads them either.

const benchOf = (list) => list.map((o) => ({ name: o.name, hpPct: o.hpPct, status: o.status || null }));

// Which request the player answered for this moment:
//   'replacement' -> turn.forceSwitch (after a faint or a pivot such as U-turn)
//   'turn'        -> turn.available   (the normal choice at the start of the turn)
// bad-replacement is always a replacement. low-hp-switch-in can be either, and its facts do
// not say which: a switch made before any move or faint is a normal choice, anything else is
// the replacement. (A turn can hold both requests, e.g. T12: my Pokémon fainted, so the
// moves in `available` were not what the replacement was chosen from.)
function decisionKind(ctx, turn, moment) {
  if (moment.rule === 'bad-replacement') return 'replacement';
  if (moment.rule === 'low-hp-switch-in') {
    return chosenSwitches(turn, ctx.me).some((s) => s.mon === moment.mon) ? 'turn' : 'replacement';
  }
  return 'turn';
}

function optionsFor(ctx, moment) {
  try {
    const { battle, gen, me } = ctx;
    const turn = battle.turns.find((t) => t.turn === moment.turn);
    if (!turn) return null;

    if (decisionKind(ctx, turn, moment) === 'replacement') {
      if (!turn.forceSwitch) return null;
      return { kind: 'replacement', active: null, moves: [], canTerastallize: null, bench: benchOf(turn.forceSwitch.switchOptions) };
    }

    if (!turn.available) return null;
    const mine = turn.start && turn.start[me];
    // The move I actually chose: the first one of mine not called by another move.
    const chosen = mine && turn.moves.find((m) => m.side === me && !m.source && m.mon === mine.name);
    return {
      kind: 'turn',
      active: mine ? mine.name : null,
      moves: turn.available.moves.map((m) => {
        const data = getMove(gen, m.name);
        return {
          name: m.name, type: data ? data.type : null, pp: m.pp, maxpp: m.maxpp, disabled: !!m.disabled,
          used: !!chosen && toId(chosen.move) === toId(m.name),
        };
      }),
      canTerastallize: turn.available.canTerastallize || null,
      bench: benchOf(turn.available.switchOptions),
    };
  } catch {
    return null; // display-only extra: never let it break the review
  }
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
    const switched = switchRules(ctx, ti);
    found.push(...moveIntoImmunity(ctx, ti), ...switched, ...riskySwitch(ctx, ti, switched), ...moveChoiceRules(ctx, ti), ...goodTera(ctx, ti), ...badTera(ctx, ti), ...moveFailed(ctx, ti));
  }

  // The replacement rules run after the main loop because low-hp-switch-in must know which
  // switch-ins bad-replacement already flagged (one moment per mistake).
  const bad = [];
  for (let ti = 1; ti < battle.turns.length; ti++) {
    if (battle.turns[ti].start) bad.push(...badReplacement(ctx, ti));
  }
  found.push(...bad);
  const flagged = new Set(bad.map((f) => `${f.moment.turn}|${f.moment.mon}`));
  for (let ti = 1; ti < battle.turns.length; ti++) {
    if (battle.turns[ti].start) found.push(...lowHpSwitchIn(ctx, ti, flagged));
  }

  // A streak replaces the individual found-the-ko moments inside it (they are listed in its facts).
  const streaks = stayRules(ctx); // ko-streak and setup-paid-off
  const inStreak = (m) => m.rule === 'found-the-ko' && streaks.some((s) => s.streak.mon === m.mon && s.streak.kos.some((k) => k.turn === m.turn));
  const kept = found.filter((f) => !inStreak(f.moment));
  found.length = 0;
  found.push(...kept, ...streaks);
  // Turns are already in order; seq orders moments within a turn.
  found.sort((a, b) => a.moment.turn - b.moment.turn || a.seq - b.seq);
  review.moments = found.map((f) => f.moment);
  // Last step, after every rule has run: the rules above never see `options`.
  for (const m of review.moments) m.options = optionsFor(ctx, m);
  return review;
}

// For scripts/show-review.js: what the move-choice rules saw on every turn they could judge
// (the options and their damage ranges), whether or not anything was flagged.
function describeMoveChoices(battle, { config } = {}) {
  const cfg = { ...CONFIG, ...config, labels: { ...CONFIG.labels, ...(config && config.labels) } };
  const me = battle.me;
  if ((me !== 'p1' && me !== 'p2') || !Number.isInteger(battle.gen)) return [];
  const ctx = { battle, cfg, gen: battle.gen, me, opp: otherSide(me) };
  const out = [];
  for (let ti = 1; ti < battle.turns.length; ti++) {
    if (!battle.turns[ti].start) continue;
    const c = moveChoice(ctx, ti);
    if (!c) continue;
    out.push({
      turn: c.turn.turn, oppMon: c.theirs.name, oppHpPct: c.hp, chosen: c.chosenOpt.name, knockedOut: !!c.chosen.knockedOut,
      options: [c.chosenOpt, ...c.others].map((o) => ({
        name: o.name, minPct: o.est.minPct, maxPct: o.est.maxPct, guaranteedKo: o.est.guaranteedKo,
        possibleKo: o.est.possibleKo, abilitiesTried: o.est.abilitiesTried,
      })),
    });
  }
  return out;
}

module.exports = { buildReview, describeMoveChoices, CONFIG };
