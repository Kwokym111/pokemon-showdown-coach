// Tests for data.js. The expected values are well-known game facts (so a wrong dataset or a
// wrong wrapper would fail), plus real battles from test-data/ for the Tera / Transform cases.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const data = require('../src/core/data');
const { buildBattle } = require('../src/core/state');

const DIR = path.join(__dirname, '..', 'test-data');
const load = (f) => buildBattle(fs.readFileSync(path.join(DIR, f), 'utf8').split('\n'));

test('getSpecies: types and base stats, per generation', () => {
  const dp = data.getSpecies(9, 'Dragapult');
  assert.deepStrictEqual(dp.types, ['Dragon', 'Ghost']);
  assert.strictEqual(typeof dp.baseStats.spe, 'number');
  assert.strictEqual(data.getSpecies(5, 'Dragapult'), null); // does not exist yet in Gen 5
  assert.deepStrictEqual(data.getSpecies(9, 'Ogerpon-Wellspring').types, ['Grass', 'Water']);
  // Clefairy was Normal until Gen 6 made it Fairy.
  assert.deepStrictEqual(data.getSpecies(5, 'Clefairy').types, ['Normal']);
  assert.deepStrictEqual(data.getSpecies(6, 'Clefairy').types, ['Fairy']);
});

test('getSpecies / getMove: unknown names return null, never throw', () => {
  assert.strictEqual(data.getSpecies(9, 'Not A Pokemon'), null);
  assert.strictEqual(data.getMove(9, 'Not A Move'), null);
  assert.strictEqual(data.getSpecies(9, undefined), null);
});

test('getMove: status is the major status a move inflicts, else null', () => {
  assert.strictEqual(data.getMove(9, 'Thunder Wave').status, 'par');
  assert.strictEqual(data.getMove(9, 'Toxic').status, 'tox');
  assert.strictEqual(data.getMove(9, 'Will-O-Wisp').status, 'brn');
  assert.strictEqual(data.getMove(9, 'Rest').status, null); // heals itself, inflicts nothing on a target
  assert.strictEqual(data.getMove(9, 'Close Combat').status, null);
});

test('getMove: basics, forgiving names, per-generation category', () => {
  const cc = data.getMove(9, 'Close Combat');
  assert.deepStrictEqual(
    [cc.name, cc.type, cc.category, cc.basePower, cc.accuracy, cc.priority],
    ['Close Combat', 'Fighting', 'Physical', 120, 100, 0],
  );
  assert.strictEqual(data.getMove(9, 'closecombat').name, 'Close Combat');
  assert.strictEqual(data.getMove(9, 'Bulk Up').category, 'Status');
  assert.strictEqual(data.getMove(9, 'Quick Attack').priority, 1);
  // Gens 1 to 3: category follows the type. Dark was special, Ghost was physical.
  assert.strictEqual(data.getMove(3, 'Bite').category, 'Special');
  assert.strictEqual(data.getMove(4, 'Bite').category, 'Physical');
  assert.strictEqual(data.getMove(3, 'Shadow Ball').category, 'Physical');
  // Fairy-type moves do not exist before Gen 6.
  assert.strictEqual(data.getMove(9, 'Moonblast').type, 'Fairy');
  assert.strictEqual(data.getMove(5, 'Moonblast'), null);
});

test('getAbility / getMove.shortDesc: descriptions, unknown names return null', () => {
  const a = data.getAbility(9, 'Intimidate');
  assert.strictEqual(a.name, 'Intimidate');
  assert.ok(a.shortDesc.length > 0);
  assert.strictEqual(data.getAbility(9, 'Not An Ability'), null);
  assert.strictEqual(data.getAbility(9, undefined), null);
  assert.ok(data.getMove(9, 'Knock Off').shortDesc.length > 0);
});

test('typeMultiplier: single and dual types', () => {
  assert.strictEqual(data.typeMultiplier(9, 'Fighting', ['Normal']), 2);
  assert.strictEqual(data.typeMultiplier(9, 'Normal', ['Ghost']), 0);
  assert.strictEqual(data.typeMultiplier(9, 'Dark', ['Ghost', 'Psychic']), 4);
  assert.strictEqual(data.typeMultiplier(9, 'Ice', ['Grass', 'Flying']), 4);
  assert.strictEqual(data.typeMultiplier(9, 'Fire', ['Water', 'Rock']), 0.25);
  assert.strictEqual(data.typeMultiplier(9, 'Water', ['Fire']), 2);
});

test('typeMultiplier: the chart really changes between generations', () => {
  // Steel resisted Ghost before Gen 6.
  assert.strictEqual(data.typeMultiplier(5, 'Ghost', ['Steel']), 0.5);
  assert.strictEqual(data.typeMultiplier(6, 'Ghost', ['Steel']), 1);
  // The Gen 1 bug: Ghost did nothing to Psychic.
  assert.strictEqual(data.typeMultiplier(1, 'Ghost', ['Psychic']), 0);
  assert.strictEqual(data.typeMultiplier(2, 'Ghost', ['Psychic']), 2);
  // Dragon is hit by Fairy from Gen 6; in Gen 5 the type does not exist (null, not a guess).
  assert.strictEqual(data.typeMultiplier(6, 'Fairy', ['Dragon']), 2);
  assert.strictEqual(data.typeMultiplier(5, 'Fairy', ['Dragon']), null);
  assert.strictEqual(data.typeMultiplier(5, 'Dragon', ['Fairy']), null);
});

test('typeMultiplier: bad input gives null, bad gen throws', () => {
  assert.strictEqual(data.typeMultiplier(9, 'Nope', ['Fire']), null);
  assert.strictEqual(data.typeMultiplier(9, 'Fire', []), null);
  assert.strictEqual(data.typeMultiplier(9, 'Fire', 'Water'), null);
  assert.strictEqual(data.typeMultiplier(9, 'Stellar', ['Fire']), null);
  for (const bad of [0, 10, 9.5, '9', null, undefined]) {
    assert.throws(() => data.typeMultiplier(bad, 'Fire', ['Water']), RangeError, String(bad));
    assert.throws(() => data.getSpecies(bad, 'Pikachu'), RangeError, String(bad));
  }
});

test('typeChart: weaknesses, resistances and immunities in one object', () => {
  const c = data.typeChart(9, ['Ghost', 'Psychic']);
  assert.strictEqual(c.Dark, 4);
  assert.strictEqual(c.Ghost, 4);
  assert.strictEqual(c.Normal, 0);
  assert.strictEqual(c.Fighting, 0);
  assert.strictEqual(c.Fire, 1);
  assert.strictEqual(c.Poison, 0.5);
  assert.ok(!('Stellar' in c) && !('???' in c));
});

test('typeChart: only types that exist in that generation', () => {
  assert.ok('Fairy' in data.typeChart(9, ['Normal']));
  assert.ok(!('Fairy' in data.typeChart(5, ['Normal'])));
  assert.strictEqual(Object.keys(data.typeChart(5, ['Normal'])).length, 17);
  assert.strictEqual(Object.keys(data.typeChart(9, ['Normal'])).length, 18);
  assert.strictEqual(data.typeChart(5, ['Fairy']), null);
  assert.strictEqual(data.typeChart(9, []), null);
});

test('typeChart agrees with typeMultiplier for every attacking type', () => {
  for (const gen of [2, 5, 6, 9]) { // Steel does not exist in Gen 1
    const chart = data.typeChart(gen, ['Steel', 'Flying']);
    for (const [attack, mult] of Object.entries(chart)) {
      assert.strictEqual(mult, data.typeMultiplier(gen, attack, ['Steel', 'Flying']), `gen ${gen} ${attack}`);
    }
  }
});

test('currentTypes: species, Tera, Stellar, typeOverride, Transform (hand-made mons)', () => {
  const base = { species: 'Vigoroth', terastallized: false, teraType: null, typeOverride: null, transformedInto: null };
  assert.deepStrictEqual(data.currentTypes(9, base), ['Normal']);
  assert.deepStrictEqual(data.currentTypes(9, { ...base, terastallized: true, teraType: 'Ghost' }), ['Ghost']);
  // Planning to Tera (teraType known from my request) is not the same as having Terastallized.
  assert.deepStrictEqual(data.currentTypes(9, { ...base, teraType: 'Ghost' }), ['Normal']);
  // Stellar keeps the original types.
  assert.deepStrictEqual(data.currentTypes(9, { ...base, species: 'Dragapult', terastallized: true, teraType: 'Stellar' }), ['Dragon', 'Ghost']);
  assert.deepStrictEqual(data.currentTypes(9, { ...base, typeOverride: ['Fire'] }), ['Fire']);
  // Tera wins over an earlier type change.
  assert.deepStrictEqual(data.currentTypes(9, { ...base, typeOverride: ['Fire'], terastallized: true, teraType: 'Water' }), ['Water']);
  assert.deepStrictEqual(data.currentTypes(9, { ...base, species: 'Ditto', transformedInto: 'Pawmot' }), ['Electric', 'Fighting']);
  assert.strictEqual(data.currentTypes(9, { ...base, species: 'Not A Pokemon' }), null);
  assert.strictEqual(data.currentTypes(9, null), null);
});

test('currentTypes: the returned array is a copy', () => {
  const a = data.currentTypes(9, { species: 'Dragapult' });
  a.push('Fire');
  assert.deepStrictEqual(data.currentTypes(9, { species: 'Dragapult' }), ['Dragon', 'Ghost']);
});

test('real battle: Tera-Ghost Vigoroth is immune to Fighting (and took no damage)', () => {
  const b = load('battle-gen9randombattle-2707357132.log');
  const vig = b.turns[1].end.p1; // Vigoroth, Terastallized into Ghost on turn 1
  assert.strictEqual(vig.species, 'Vigoroth');
  assert.deepStrictEqual(data.currentTypes(b.gen, vig), ['Ghost']);
  assert.strictEqual(data.typeMultiplier(b.gen, 'Fighting', data.currentTypes(b.gen, vig)), 0);
  // Cross-check against what Showdown itself reported for Close Combat on that turn.
  const cc = b.turns[1].moves.find((m) => m.move === 'Close Combat');
  assert.strictEqual(cc.effectiveness, 'immune');
  const ccType = data.getMove(b.gen, cc.move).type;
  assert.strictEqual(data.typeMultiplier(b.gen, ccType, data.currentTypes(b.gen, vig)), 0);
  // Before Tera it was plain Normal, which Fighting hits for double.
  assert.deepStrictEqual(data.currentTypes(b.gen, b.turns[1].start.p1), ['Normal']);
});

test('real battle: every Pokémon in every log has types in its battle generation', () => {
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.log'))) {
    const b = load(f);
    for (const t of b.turns) {
      for (const mon of [t.start && t.start.p1, t.start && t.start.p2, t.end && t.end.p1, t.end && t.end.p2]) {
        if (!mon) continue;
        const types = data.currentTypes(b.gen, mon);
        assert.ok(Array.isArray(types) && types.length >= 1, `${f}: ${mon.species} has no types`);
      }
    }
  }
});

test('real battle: Ditto that Imposter-copied Pawmot has Pawmot\'s types', () => {
  const b = load('latest_battle.log');
  const ditto = b.turns.map((t) => t.end && t.end.p2).find((m) => m && m.species === 'Ditto' && m.transformedInto);
  assert.ok(ditto, 'no transformed Ditto found');
  assert.strictEqual(ditto.transformedInto, 'Pawmot');
  assert.deepStrictEqual(data.currentTypes(b.gen, ditto), ['Electric', 'Fighting']);
});

test('getSpecies: abilities per generation (hidden ones included, empty before Gen 3)', () => {
  assert.deepStrictEqual(data.getSpecies(9, 'Gholdengo').abilities, ['Good as Gold']);
  assert.deepStrictEqual(data.getSpecies(9, 'Dragapult').abilities, ['Clear Body', 'Infiltrator', 'Cursed Body']);
  assert.deepStrictEqual(data.getSpecies(5, 'Garchomp').abilities, ['Sand Veil', 'Rough Skin']);
  assert.deepStrictEqual(data.getSpecies(2, 'Snorlax').abilities, []);
  assert.deepStrictEqual(data.getSpecies(1, 'Snorlax').abilities, []);
});
