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
//    -> { name, types: ['Dragon', 'Ghost'], baseStats: { hp, atk, def, spa, spd, spe } } | null
//    A species' ORIGINAL types and base stats in that generation. Ignores Tera and
//    in-battle type changes; for the types a Pokémon has right now use currentTypes.
//
//  getMove(gen, name)
//    -> { name, type, category, basePower, accuracy, priority } | null
//    category is 'Physical' | 'Special' | 'Status'. accuracy is a number (0 to 100) or
//    `true` for moves that never miss. These are the move's BASE values: moves whose type
//    or power depends on the situation (Tera Blast, Weather Ball, Hidden Power, Judgment,
//    Low Kick...) are not resolved here. For what a move really did in a battle, use the
//    `effectiveness` and `damagePct` fields that buildBattle recorded from the log.
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
  return { name: sp.name, types: [...sp.types], baseStats: { ...sp.baseStats } };
}

function getMove(gen, name) {
  const g = genData(gen);
  const mv = isName(name) ? g.moves.get(name) : undefined;
  if (!mv) return null;
  return {
    name: mv.name, type: mv.type, category: mv.category,
    basePower: mv.basePower, accuracy: mv.accuracy, priority: mv.priority,
  };
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

module.exports = { getSpecies, getMove, typeMultiplier, typeChart, currentTypes };
