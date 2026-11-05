// data.js: generation-aware Pokémon reference data (types, type matchups, moves).
// Pure: no electron, fs or network. It only reads the bundled @pkmn/dex data through
// @pkmn/data, so it runs in plain Node and in tests.
//
// WHY THIS FILE EXISTS: nothing else in the app may hard-code Pokémon facts ("Fire is weak
// to Water"). Facts change between generations (Fairy only exists from Gen 6; Steel resisted
// Ghost and Dark before Gen 6; Ghost did not affect Psychic in Gen 1; move category followed
// the move's TYPE in Gens 1 to 3), so every function takes the battle's generation first.
// Read the generation from the battle: `buildBattle(lines).gen` (a number, 1 to 9).
//
// CONVENTIONS
//  - `gen` is an integer 1..9. Anything else throws a RangeError (that is a programming
//    bug, not bad battle data).
//  - Names are Showdown's display names ("Close Combat", "Ogerpon-Wellspring", "Ghost").
//    Case and punctuation are forgiven for species and moves ("closecombat" also works).
//    Type names are matched exactly and are capitalised ("Ghost", not "ghost").
//  - Things that do not exist in that generation (Dragapult in Gen 5, Fairy in Gen 5)
//    come back as `null`. Functions never throw because of unknown names, so one odd
//    species in a log cannot crash a whole review. Always handle `null`.
//  - A "multiplier" is the damage factor of a type matchup: 0 (immune), 0.25, 0.5, 1, 2, 4.
//
// EXPORTS
//
//  getSpecies(gen, name)
//    -> { name, types: ['Dragon', 'Ghost'], baseStats: { hp, atk, def, spa, spd, spe },
//         abilities: ['Clear Body', 'Infiltrator', 'Cursed Body'] } | null
//    A species' ORIGINAL types and base stats in that generation. Ignores Tera and
//    in-battle type changes; for the types a Pokémon has right now use currentTypes.
//    `abilities` lists every ability the species can have in that generation, hidden ones
//    included; it is empty before Gen 3.
//
//  getMove(gen, name)
//    -> { name, type, category, basePower, accuracy, priority, selfSwitch, charge, recharge,
//         selfDestruct, lockedMove, selfDebuff, status, shortDesc } | null
//    `shortDesc` is the one-line description text ('' if the data has none).
//    category is 'Physical' | 'Special' | 'Status'. accuracy is a number (0 to 100) or
//    `true` for moves that never miss. The last six are booleans for what the move commits
//    you to: pivots out, takes a turn to charge, needs a recharge turn, makes the user
//    faint, locks you in for several turns, lowers your own stats. `status` is the major
//    status the move inflicts ('par', 'tox'...) or null (Thunder Wave is 'par', Rest is null).
//    These are the move's BASE values: moves whose type
//    or power depends on the situation (Tera Blast, Weather Ball, Hidden Power, Judgment,
//    Low Kick...) are not resolved here. For what a move really did in a battle, use the
//    `effectiveness` and `damagePct` fields that buildBattle recorded from the log.
//
//  getAbility(gen, name)
//    -> { name, shortDesc } | null
//    An ability's display name and one-line description. null if unknown in that generation.
//
//  getStatusName(status)
//    -> 'Paralyzed' | 'Burned' | 'Poisoned' | 'Badly poisoned' | 'Asleep' | 'Frozen' | null
//    A readable name for Showdown's status id ('par', 'tox'...). null for no status.
//
//  getFieldEffect(gen, id)
//    -> { name, shortDesc } | null
//    A readable name and one-line description for a weather ('RainDance'), terrain
//    ('Electric Terrain') or screen ('Reflect') id as stored in buildBattle's `field`.
//
//  getVolatile(gen, label)
//    -> { name, shortDesc } | null
//    A readable name and one-line description for a volatile effect name as stored in
//    mon.volatiles ('Leech Seed', 'confusion', 'perish3'). Also fine for a side condition
//    such as 'Stealth Rock' (getFieldEffect does the same job for weather, terrain, screens).
//
//  typeMultiplier(gen, attackType, defenderTypes)
//    -> number | null
//    How much damage an attack of `attackType` does to a defender with `defenderTypes`
//    (one or two type names), e.g. typeMultiplier(9, 'Ice', ['Grass', 'Flying']) === 4.
//    Returns null if any of the types does not exist in that generation. Stellar is not
//    treated as a type here.
//
//  typeChart(gen, defenderTypes)
//    -> { Bug: 1, Dark: 0.5, ..., Water: 2 } | null
//    typeMultiplier for EVERY attacking type that exists in that generation, in one object.
//    Use it to list a Pokémon's weaknesses (values > 1), resistances (0 < value < 1) and
//    immunities (value 0). null if a defender type does not exist in that generation.
//
//  currentTypes(gen, mon)
//    -> ['Ghost'] | null
//    The types a Pokémon has RIGHT NOW. `mon` is a Pokémon object from buildBattle
//    (turn.start.p1, turn.end.p2, ...); only species, terastallized, teraType,
//    typeOverride and transformedInto are read. First rule that applies wins:
//      1. Terastallized (and not Stellar): just the Tera type.
//         Stellar keeps the original types, as in the game.
//      2. typeOverride (moves/abilities that changed its type, from the log).
//      3. transformedInto (Ditto/Transform/Imposter): the copied species' types.
//      4. Its own species' types.
//    null if the species is unknown in that generation.
//    NOT handled: Roost's temporary loss of Flying, Illusion, Mega/Dynamax forms.

const { Dex } = require('@pkmn/dex');
const { Generations } = require('@pkmn/data');

// Building Generations is cheap but we call this on every lookup, so keep one.
const gens = new Generations(Dex);

function genData(gen) {
  if (!Number.isInteger(gen)) throw new RangeError(`gen must be an integer 1 to 9, got ${gen}`);
  try {
    return gens.get(gen);
  } catch (e) {
    throw new RangeError(`unsupported generation ${gen}`);
  }
}

// An attacking or defending type is only valid if it exists in this generation. This check
// matters: @pkmn/data's own totalEffectiveness quietly answers for a Gen 6 type like Fairy
// when asked in Gen 5, using the defender's modern data, which would be a wrong answer.
function isRealType(g, name) {
  const t = typeof name === 'string' ? g.types.get(name) : undefined;
  return !!t && t.name !== 'Stellar';
}

// The package throws on a non-string name (e.g. undefined from a half-parsed line), which
// would break the "never throws on unknown names" promise above, so guard it here.
const isName = (name) => typeof name === 'string' && name !== '';

function getSpecies(gen, name) {
  const g = genData(gen);
  const sp = isName(name) ? g.species.get(name) : undefined;
  if (!sp) return null;
  return {
    name: sp.name, types: [...sp.types], baseStats: { ...sp.baseStats },
    abilities: Object.values(sp.abilities || {}).filter(Boolean), // Gens 1 and 2 give { 0: '' }
  };
}

function getMove(gen, name) {
  const g = genData(gen);
  const mv = isName(name) ? g.moves.get(name) : undefined;
  if (!mv) return null;
  const flags = mv.flags || {};
  const self = mv.self || {};
  return {
    name: mv.name, type: mv.type, category: mv.category,
    basePower: mv.basePower, accuracy: mv.accuracy, priority: mv.priority,
    // What using the move costs or commits you to (all from the data, so they follow the gen):
    selfSwitch: !!mv.selfSwitch, // U-turn, Volt Switch, Flip Turn...
    charge: !!flags.charge, // hits a turn later (Solar Beam, Fly, Meteor Beam)
    recharge: !!flags.recharge, // must rest afterwards (Hyper Beam)
    selfDestruct: !!mv.selfdestruct, // the user faints (Explosion)
    lockedMove: self.volatileStatus === 'lockedmove', // Outrage, Petal Dance
    selfDebuff: !!(self.boosts && Object.values(self.boosts).some((v) => v < 0)), // Close Combat, Overheat
    // The major status the move inflicts ('par', 'brn', 'psn', 'tox', 'slp', 'frz'), else null.
    status: mv.status || null,
    // One-line description from the bundled data (what Showdown shows on hover). '' if none.
    shortDesc: mv.shortDesc || '',
  };
}

function getAbility(gen, name) {
  const g = genData(gen);
  const ab = isName(name) ? g.abilities.get(name) : undefined;
  if (!ab) return null;
  return { name: ab.name, shortDesc: ab.shortDesc || '' };
}

// Display names only (labels, not game facts): Showdown's status ids and weather ids are
// not readable on their own. Unknown ids fall back to the id itself.
const STATUS_NAMES = { par: 'Paralyzed', brn: 'Burned', psn: 'Poisoned', tox: 'Badly poisoned', slp: 'Asleep', frz: 'Frozen' };
const WEATHER_NAMES = {
  RainDance: 'Rain', SunnyDay: 'Sun', Sandstorm: 'Sandstorm', Snowscape: 'Snow', Hail: 'Hail',
  DesolateLand: 'Harsh sunlight', PrimordialSea: 'Heavy rain', DeltaStream: 'Strong winds',
};

function getStatusName(status) {
  if (!isName(status)) return null;
  return STATUS_NAMES[status] || status.toUpperCase();
}

function getFieldEffect(gen, id) {
  const g = genData(gen);
  if (!isName(id)) return null;
  // Weather, terrain and screens are all started by a move (Rain Dance, Electric Terrain,
  // Reflect), so that move's one-line description is the description. Weather from an
  // ability (Drizzle) is the same weather. Special weathers have no move: no description.
  const mv = g.moves.get(id);
  return { name: WEATHER_NAMES[id] || id, shortDesc: mv ? mv.shortDesc || '' : '' };
}

// "perish3" -> "Perish 3", "confusion" -> "Confusion", "Leech Seed" stays as it is.
function prettyEffect(label) {
  const spaced = label.replace(/(\D)(\d+)$/, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function getVolatile(gen, label) {
  const g = genData(gen);
  if (!isName(label)) return null;
  // Most volatile effects are started by a move (Leech Seed, Substitute, Taunt), and that
  // move's one-line description is the description. Effects without a move of their own
  // (confusion) get a name and no description.
  // Careful: a lowercase label ('confusion', 'perish3') is a condition id, not a move, and
  // looking it up as a move finds the WRONG thing (the move Confusion, "10% chance to
  // confuse"). Real move names are capitalised in the log ('Leech Seed', 'Substitute').
  const isConditionId = label === label.toLowerCase();
  const mv = isConditionId ? null : g.moves.get(label);
  return { name: prettyEffect(label), shortDesc: mv ? mv.shortDesc || '' : '' };
}

function typeMultiplier(gen, attackType, defenderTypes) {
  const g = genData(gen);
  if (!Array.isArray(defenderTypes) || defenderTypes.length === 0) return null;
  if (!isRealType(g, attackType) || !defenderTypes.every((t) => isRealType(g, t))) return null;
  return g.types.totalEffectiveness(attackType, defenderTypes);
}

function typeChart(gen, defenderTypes) {
  const g = genData(gen);
  if (!Array.isArray(defenderTypes) || defenderTypes.length === 0) return null;
  if (!defenderTypes.every((t) => isRealType(g, t))) return null;
  const chart = {};
  for (const t of g.types) {
    if (!isRealType(g, t.name)) continue; // skips '???' and Stellar if the iterator yields them
    chart[t.name] = g.types.totalEffectiveness(t.name, defenderTypes);
  }
  return chart;
}

function currentTypes(gen, mon) {
  const g = genData(gen);
  if (!mon) return null;

  if (mon.terastallized && mon.teraType && mon.teraType !== 'Stellar') {
    return isRealType(g, mon.teraType) ? [mon.teraType] : null;
  }
  if (mon.typeOverride && mon.typeOverride.length) return [...mon.typeOverride];

  const name = mon.transformedInto || mon.species;
  const sp = isName(name) ? g.species.get(name) : undefined;
  return sp ? [...sp.types] : null;
}

module.exports = { getSpecies, getMove, getAbility, getStatusName, getFieldEffect, getVolatile, typeMultiplier, typeChart, currentTypes };
