// damage.js: damage estimates for one attack, using @smogon/calc (the engine behind
// calc.pokemonshowdown.com). Pure: no electron, fs or network.
//
// WHY THIS FILE EXISTS: the review rules compare the move the player chose with their other
// options ("which was best, and how far off was yours?"). That needs a number per option
// like "45-53% of its HP, guaranteed KO". This file only makes those numbers. It does not
// judge anything.
//
// The calc is loaded through '@smogon/calc/dist/adaptable', which accepts a @pkmn/data
// Generation. That way the calc and data.js read the same @pkmn/dex data.
//
// ASSUMPTIONS (an estimate is only as good as these; scripts/check-damage.js measures it)
//  - RANDOM BATTLE SPREADS: every Pokémon has 84 EVs in each stat, 31 IVs and a neutral
//    nature (Hardy). Checked against the |request| stats in test-data/ (test/damage.test.js).
//    This is a Random Battle assumption: in a battle with real teams the numbers can be
//    far off. The calc works in any generation, but the spreads are only validated for
//    Gen 9. In Gens 1 and 2 the stat system is different (DVs, stat experience), so there
//    the calc's own defaults are used instead of the 84/31 spread, unchecked.
//  - TWO RANDOM BATTLE EXCEPTIONS, both found by the stats test, both for MY Pokémon only
//    (the opponent's set is hidden, so for them the plain spread is used):
//      * 0 Atk IV AND 0 Atk EVs when the set has no Physical move (Body Press and Foul Play
//        do not count, Shell Side Arm does, Transform/Copycat sets keep 84/31). It only
//        changes damage that uses the Pokémon's Atk. For the opponent this means Foul Play
//        and confusion damage can be too high when their set was all-special.
//      * Random Battle sometimes takes 4 EVs off HP (to make the HP number odd/even or
//        divisible in a useful way). Instead of copying that logic, the HP EVs are found by
//        matching the real max HP from |request|. Opponent max HP can be 1 off.
//  - An UNKNOWN item or ability counts as NONE. The opponent's are null until the log
//    reveals them. Ids from |request| ("choiceband") are turned into display names. The
//    calc would otherwise quietly give a Pokémon its species' first ability, so "No Ability"
//    is passed on purpose.
//  - STAT BOOSTS come from `mon.boosts` (state.js tracks them). WEATHER, TERRAIN and
//    SCREENS (Reflect, Light Screen, Aurora Veil) are used only when the caller passes
//    `options.field`: either a turn's `field` snapshot from buildBattle (turn.field) or a
//    @smogon/calc Field. Without it the field is empty. They matter a lot: Flare Blitz is
//    62-74% without Sun and 125-147% in Sun. Not modelled: Gravity, Trick Room, Magic and
//    Wonder Room, Baton Pass boosts, abilities that need a trigger the log did not show.
//  - NO critical hits. ONE use of the move (the calc's normal damage range, 16 rolls).
//  - Status moves have no damage and return null.
//  - Only Terastallized Pokémon get a Tera type, because in the calc `teraType` means "is
//    Terastallized now". The planned (not yet used) Tera type is never passed.
//
// EXPORTS
//
//  estimateDamage(gen, attacker, defender, moveName, options = {})
//    -> null | { move, category, minPct, maxPct, defenderHpPct, guaranteedKo, possibleKo,
//                koChance, desc }
//    `attacker` / `defender` are Pokémon objects from buildBattle (turn.start.p1, ...).
//    minPct / maxPct: damage as a % of the defender's MAX HP, rounded DOWN to 1 decimal,
//      exactly as calc.pokemonshowdown.com prints it.
//    defenderHpPct: the defender's current HP % that was used (its `hpPct`).
//    guaranteedKo / possibleKo: whether the lowest / highest roll takes at least the
//      defender's current HP. Worked out in real HP points, so rounding of the % fields
//      cannot flip them.
//    koChance: the calc's { chance, n, text } ("guaranteed 2HKO").
//    desc: the calc's description line, for debugging and AI facts.
//    null when there is nothing to estimate: missing Pokémon, unknown species or move, a
//    status move, a fainted defender. Never throws because of battle data. A bad `gen`
//    throws a RangeError, the same as data.js.
//
//  calcField(snapshot, attackerSide, defenderSide)
//    -> a @smogon/calc Field built from a buildBattle field snapshot ({ weather, terrain,
//    screens }, e.g. turn.field). Screens count only on the DEFENDER's side. Unknown
//    weather or terrain ids are ignored. estimateDamage does this for you when you pass the
//    snapshot as `options.field`.
//
//  calcPokemon(gen, mon)
//    -> a @smogon/calc Pokemon (or null). Exported for tests and scripts.

const { Dex } = require('@pkmn/dex');
const { Generations } = require('@pkmn/data');
const calc = require('@smogon/calc/dist/adaptable');
const { getSpecies, getMove } = require('./data');

const gens = new Generations(Dex);

function genData(gen) {
  if (!Number.isInteger(gen)) throw new RangeError(`gen must be an integer 1 to 9, got ${gen}`);
  try {
    return gens.get(gen);
  } catch (e) {
    throw new RangeError(`unsupported generation ${gen}`);
  }
}

const SPREAD_EVS = { hp: 84, atk: 84, def: 84, spa: 84, spd: 84, spe: 84 };
const SPREAD_IVS = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };

// Round DOWN to 1 decimal. The calc's own description does the same, so our numbers match
// what Kym sees on the website (260/277 is 93.86%, shown as 93.8%).
const floor1 = (n) => Math.floor(n * 10) / 10;

// Moves that look Physical in the data but do not make Random Battle keep the Atk IV at 31.
const NOT_REALLY_PHYSICAL = new Set(['Body Press', 'Foul Play']);
const KEEPS_ATK_IV = new Set(['Transform', 'Copycat']);
// The reverse: listed as Special but it can hit as Physical, and Random Battle counts it as
// Physical (seen on Slowbro-Galar in test-data/). Photon Geyser, which is the same kind of
// move, does NOT count (seen on Necrozma).
const COUNTS_AS_PHYSICAL = new Set(['Shell Side Arm']);

// Only known for my own Pokémon (mon.moveset comes from |request|).
function hasNoPhysicalMoves(gen, moveset) {
  if (!Array.isArray(moveset) || moveset.length === 0) return false;
  const moves = moveset.map((m) => getMove(gen, m)).filter(Boolean);
  if (moves.some((m) => KEEPS_ATK_IV.has(m.name))) return false;
  return !moves.some((m) => COUNTS_AS_PHYSICAL.has(m.name) || (m.category === 'Physical' && !NOT_REALLY_PHYSICAL.has(m.name)));
}

// "choiceband" or "Choice Band" -> "Choice Band"; null if it does not exist in this gen.
function displayName(table, name) {
  if (typeof name !== 'string' || name === '') return null;
  const found = table.get(name);
  return found ? found.name : null;
}

// A calc Pokémon from a buildBattle Pokémon. Exported for the tests and scripts, which
// compare its stats with the real ones in |request|. Returns null if the species is unknown.
function calcPokemon(gen, mon) {
  const g = genData(gen);
  if (!mon) return null;
  const sp = getSpecies(gen, mon.transformedInto || mon.species);
  if (!sp) return null;

  const options = {
    level: Number.isInteger(mon.level) ? mon.level : 100,
    nature: 'Hardy',
    // Display names only: |request| gives ids ("choiceband"), which the calc would silently
    // ignore. Unknown ones count as none.
    ability: displayName(g.abilities, mon.ability) || 'No Ability',
    status: mon.status || '',
  };
  if (gen >= 3) {
    options.evs = { ...SPREAD_EVS };
    options.ivs = { ...SPREAD_IVS };
    if (hasNoPhysicalMoves(gen, mon.moveset)) { options.ivs.atk = 0; options.evs.atk = 0; }
  }
  const item = displayName(g.items, mon.item);
  if (item) options.item = item;
  // `teraType` in the calc means "is Terastallized". Stellar is not a real type for it.
  if (mon.terastallized && mon.teraType && mon.teraType !== 'Stellar') options.teraType = mon.teraType;
  if (mon.boosts) {
    const { atk, def, spa, spd, spe } = mon.boosts;
    options.boosts = { atk, def, spa, spd, spe };
    if (gen === 1) options.boosts.spc = spa; // Gen 1 has a single Special stat
  }

  try {
    // A REAL max HP (not the 100 of a percentage) is known for my own Pokémon: use it to find
    // the HP EVs, walking down from 84 in steps of 4 like the Random Battle generator does.
    // Not for Transform: the copier keeps its own HP, not the copied species'.
    const knownMaxHp = mon.hpKind === 'real' && !mon.transformedInto ? mon.maxHp : null;
    if (gen >= 3 && knownMaxHp) {
      for (let hpEvs = options.evs.hp; hpEvs >= 0; hpEvs -= 4) {
        const cp = new calc.Pokemon(g, sp.name, { ...options, evs: { ...options.evs, hp: hpEvs } });
        if (cp.maxHP() === knownMaxHp) return cp;
      }
    }
    return new calc.Pokemon(g, sp.name, options);
  } catch (e) {
    return null; // e.g. an item or type the calc does not know
  }
}

// The calc wants real HP; battle Pokémon only reliably have a percentage (opponents).
function setHpFromPct(cp, hpPct) {
  if (typeof hpPct !== 'number') return;
  const cur = Math.max(1, Math.round((hpPct / 100) * cp.maxHP()));
  cp.originalCurHP = Math.min(cur, cp.maxHP());
}

// Showdown's weather and terrain ids -> the calc's names.
const WEATHER = {
  SunnyDay: 'Sun', RainDance: 'Rain', Sandstorm: 'Sand', Hail: 'Hail', Snow: 'Snow',
  DesolateLand: 'Harsh Sunshine', PrimordialSea: 'Heavy Rain', DeltaStream: 'Strong Winds',
};
const TERRAIN = {
  'Electric Terrain': 'Electric', 'Grassy Terrain': 'Grassy', 'Misty Terrain': 'Misty', 'Psychic Terrain': 'Psychic',
};

function calcField(snapshot, attackerSide, defenderSide) {
  if (!snapshot) return new calc.Field();
  const field = {};
  if (WEATHER[snapshot.weather]) field.weather = WEATHER[snapshot.weather];
  if (TERRAIN[snapshot.terrain]) field.terrain = TERRAIN[snapshot.terrain];
  const screens = (snapshot.screens && snapshot.screens[defenderSide]) || [];
  field.defenderSide = {
    isReflect: screens.includes('Reflect'),
    isLightScreen: screens.includes('Light Screen'),
    isAuroraVeil: screens.includes('Aurora Veil'),
  };
  return new calc.Field(field);
}

function estimateDamage(gen, attacker, defender, moveName, options = {}) {
  const g = genData(gen);
  if (!attacker || !defender) return null;
  const mv = getMove(gen, moveName); // the calc turns unknown move names into other moves
  if (!mv || mv.category === 'Status') return null;
  if (typeof defender.hpPct === 'number' && defender.hpPct <= 0) return null;

  try {
    const a = calcPokemon(gen, attacker);
    const d = calcPokemon(gen, defender);
    if (!a || !d) return null;
    setHpFromPct(a, attacker.hpPct);
    setHpFromPct(d, defender.hpPct);

    const move = new calc.Move(g, mv.name);
    // A turn.field snapshot has `screens`; anything else is passed to the calc as it is.
    const f = options.field;
    const field = f && f.screens ? calcField(f, attacker.side, defender.side) : f || new calc.Field();
    const result = calc.calculate(g, a, d, move, field);
    const [min, max] = result.range();
    const maxHp = d.maxHP();
    const curHp = d.curHP();

    return {
      move: mv.name,
      category: move.category,
      minPct: floor1((min / maxHp) * 100),
      maxPct: floor1((max / maxHp) * 100),
      defenderHpPct: typeof defender.hpPct === 'number' ? defender.hpPct : 100,
      guaranteedKo: min >= curHp,
      possibleKo: max >= curHp,
      koChance: max === 0 ? { chance: 0, n: 0, text: 'does no damage' } : result.kochance(),
      // The calc's desc() and kochance() throw when the damage is 0 (an immune target).
      desc: max === 0 ? `${a.name} ${mv.name} vs. ${d.name}: 0-0 (0%) -- no damage` : result.desc(),
    };
  } catch (e) {
    return null; // never throw because of battle data
  }
}

module.exports = { estimateDamage, calcPokemon, calcField };
