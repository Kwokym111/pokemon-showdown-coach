// Tests for damage.js. The most important one checks the Random Battle spread assumption
// against the real stats Showdown sent in every |request| in test-data/.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { estimateDamage, calcPokemon } = require('../src/core/damage');
const { parseDetails } = require('../src/core/parser');

const DIR = path.join(__dirname, '..', 'test-data');
const logs = fs.readdirSync(DIR).filter((f) => f.endsWith('.log'));

// A battle-Pokémon-shaped object with only the fields damage.js reads.
const mon = (species, level, extra = {}) => ({
  species, level, status: null, hpPct: 100, terastallized: false, teraType: null,
  transformedInto: null, item: null, ability: null, ...extra,
});

test('stats: calc stats match every |request| in test-data/ exactly', () => {
  let checked = 0;
  let hpFallbackOff = 0;
  for (const file of logs) {
    const gen = 9; // every log in test-data/ is a Gen 9 Random Battle
    for (const line of fs.readFileSync(path.join(DIR, file), 'utf8').split('\n')) {
      if (!line.startsWith('|request|')) continue;
      let req;
      try { req = JSON.parse(line.slice('|request|'.length)); } catch { continue; }
      for (const p of (req.side && req.side.pokemon) || []) {
        const d = parseDetails(p.details);
        const m = /\/(\d+)/.exec(p.condition); // "0 fnt" has no max HP
        const label = `${file} ${p.ident} ${p.details}`;

        // As for MY Pokémon in a review: moveset and real max HP are known.
        const mine = calcPokemon(gen, mon(d.species, d.level, {
          moveset: p.moves, hpKind: m ? 'real' : null, maxHp: m ? Number(m[1]) : null,
        }));
        assert.ok(mine, `no calc Pokémon for ${label}`);
        for (const stat of Object.keys(p.stats)) {
          assert.strictEqual(mine.stats[stat], p.stats[stat], `${stat} of ${label}`);
        }
        if (m) assert.strictEqual(mine.maxHP(), Number(m[1]), `max HP of ${label}`);

        // As for the OPPONENT: nothing is known, so plain 84 EVs. HP can be 1 off (the
        // generator sometimes drops 4 HP EVs); anything bigger would be a wrong assumption.
        const theirs = calcPokemon(gen, mon(d.species, d.level));
        if (m) {
          const diff = Math.abs(theirs.maxHP() - Number(m[1]));
          assert.ok(diff <= 1, `plain-spread max HP of ${label} is off by ${diff}`);
          if (diff) hpFallbackOff++;
        }
        checked++;
      }
    }
  }
  assert.ok(checked > 50, `only ${checked} Pokémon checked`);
  assert.ok(hpFallbackOff < checked / 4, 'plain-spread HP is off too often');
});

test('0 Atk IV only for sets with no physical move (Body Press / Foul Play do not count)', () => {
  const stats = (moveset) => calcPokemon(9, mon('Gengar', 81, { moveset })).stats.atk;
  const base = calcPokemon(9, mon('Gengar', 81)).stats.atk;
  assert.ok(stats(['shadowball', 'sludgewave']) < base);
  assert.ok(stats(['bodypress', 'foulplay', 'shadowball']) < base);
  assert.strictEqual(stats(['shadowball', 'earthquake']), base);
  assert.strictEqual(stats(['transform']), base);
  assert.strictEqual(stats(undefined), base); // opponent: unknown set, plain spread
});

test('known case: L80 Garchomp Earthquake vs L82 Gholdengo = 78.7-93.8%', () => {
  const r = estimateDamage(9, mon('Garchomp', 80), mon('Gholdengo', 82), 'Earthquake');
  assert.strictEqual(r.move, 'Earthquake');
  assert.strictEqual(r.category, 'Physical');
  assert.strictEqual(r.minPct, 78.7);
  assert.strictEqual(r.maxPct, 93.8);
  assert.strictEqual(r.defenderHpPct, 100);
  // The task spec called this a guaranteed OHKO, but 93.8% can never KO a full-HP target:
  // it is a guaranteed 2HKO. (The calc website says the same.)
  assert.strictEqual(r.guaranteedKo, false);
  assert.strictEqual(r.possibleKo, false);
  assert.strictEqual(r.koChance.n, 2);
  assert.strictEqual(r.koChance.chance, 1);
  assert.match(r.desc, /Garchomp Earthquake vs\. Lvl 82/);
});

test('Terastallized defender becomes immune (Gholdengo Tera Flying vs Earthquake)', () => {
  const tera = mon('Gholdengo', 82, { terastallized: true, teraType: 'Flying' });
  const r = estimateDamage(9, mon('Garchomp', 80), tera, 'Earthquake');
  assert.strictEqual(r.minPct, 0);
  assert.strictEqual(r.maxPct, 0);
  assert.strictEqual(r.possibleKo, false);
});

test('a planned (not used) Tera type is never passed to the calc', () => {
  const planned = mon('Gholdengo', 82, { plannedTera: 'Flying' });
  const r = estimateDamage(9, mon('Garchomp', 80), planned, 'Earthquake');
  assert.strictEqual(r.maxPct, 93.8);
  // Same for a Pokémon with a teraType set but not yet Terastallized.
  const notYet = mon('Gholdengo', 82, { teraType: 'Flying', terastallized: false });
  assert.strictEqual(estimateDamage(9, mon('Garchomp', 80), notYet, 'Earthquake').maxPct, 93.8);
});

test('burn roughly halves a physical move', () => {
  const normal = estimateDamage(9, mon('Garchomp', 80), mon('Gholdengo', 82), 'Earthquake');
  const burned = estimateDamage(9, mon('Garchomp', 80, { status: 'brn' }), mon('Gholdengo', 82), 'Earthquake');
  const ratio = burned.maxPct / normal.maxPct;
  assert.ok(ratio > 0.45 && ratio < 0.55, `ratio ${ratio}`);
});

test('KO flags use the defender current HP, not 100', () => {
  const half = estimateDamage(9, mon('Garchomp', 80), mon('Gholdengo', 82, { hpPct: 50 }), 'Earthquake');
  assert.strictEqual(half.defenderHpPct, 50);
  assert.strictEqual(half.minPct, 78.7); // % of MAX HP, so unchanged
  assert.strictEqual(half.guaranteedKo, true);
  assert.strictEqual(half.possibleKo, true);

  // 85% is in between: the top roll (93.8) KOs, the bottom (78.7) does not.
  const mid = estimateDamage(9, mon('Garchomp', 80), mon('Gholdengo', 82, { hpPct: 85 }), 'Earthquake');
  assert.strictEqual(mid.guaranteedKo, false);
  assert.strictEqual(mid.possibleKo, true);
});

test('null for unknown species, unknown move, status move, missing Pokémon, fainted target', () => {
  const a = mon('Garchomp', 80);
  const d = mon('Gholdengo', 82);
  assert.strictEqual(estimateDamage(9, mon('Not A Pokemon', 80), d, 'Earthquake'), null);
  assert.strictEqual(estimateDamage(9, a, mon('Not A Pokemon', 80), 'Earthquake'), null);
  assert.strictEqual(estimateDamage(9, a, d, 'Not A Move'), null);
  assert.strictEqual(estimateDamage(9, a, d, undefined), null);
  assert.strictEqual(estimateDamage(9, a, d, 'Thunder Wave'), null);
  assert.strictEqual(estimateDamage(9, null, d, 'Earthquake'), null);
  assert.strictEqual(estimateDamage(9, a, undefined, 'Earthquake'), null);
  assert.strictEqual(estimateDamage(9, a, mon('Gholdengo', 82, { hpPct: 0 }), 'Earthquake'), null);
});

test('items and abilities given as |request| ids ("choiceband") are applied', () => {
  const plain = estimateDamage(9, mon('Garchomp', 80), mon('Gholdengo', 82), 'Earthquake');
  const byId = estimateDamage(9, mon('Garchomp', 80, { item: 'choiceband' }), mon('Gholdengo', 82), 'Earthquake');
  const byName = estimateDamage(9, mon('Garchomp', 80, { item: 'Choice Band' }), mon('Gholdengo', 82), 'Earthquake');
  assert.ok(byId.maxPct > plain.maxPct * 1.4);
  assert.strictEqual(byId.maxPct, byName.maxPct);
  // Levitate (ability by id) makes the defender immune to Earthquake.
  const levitate = estimateDamage(9, mon('Garchomp', 80), mon('Rotom-Wash', 80, { ability: 'levitate' }), 'Earthquake');
  assert.strictEqual(levitate.maxPct, 0);
});

test('an unknown item does not throw', () => {
  const r = estimateDamage(9, mon('Garchomp', 80, { item: 'Not An Item' }), mon('Gholdengo', 82), 'Earthquake');
  assert.ok(r === null || typeof r.minPct === 'number');
});

test('a bad generation throws RangeError, like data.js', () => {
  const a = mon('Garchomp', 80);
  const d = mon('Gholdengo', 82);
  assert.throws(() => estimateDamage(0, a, d, 'Earthquake'), RangeError);
  assert.throws(() => estimateDamage(10, a, d, 'Earthquake'), RangeError);
  assert.throws(() => estimateDamage('9', a, d, 'Earthquake'), RangeError);
});

test('other generations work (Gen 5 Garchomp exists, Gholdengo does not)', () => {
  assert.ok(estimateDamage(5, mon('Garchomp', 80), mon('Tyranitar', 80), 'Earthquake'));
  assert.strictEqual(estimateDamage(5, mon('Garchomp', 80), mon('Gholdengo', 80), 'Earthquake'), null);
});

test('a field option is passed through (Sun boosts Fire moves)', () => {
  const calcLib = require('@smogon/calc/dist/adaptable');
  const sun = new calcLib.Field({ weather: 'Sun' });
  const none = estimateDamage(9, mon('Koraidon', 64), mon('Gholdengo', 82), 'Flare Blitz');
  const withSun = estimateDamage(9, mon('Koraidon', 64), mon('Gholdengo', 82), 'Flare Blitz', { field: sun });
  assert.ok(withSun.maxPct > none.maxPct * 1.3);
});

// --- boosts and field snapshots (what state.js tracks) ---

const field = (extra = {}) => ({ weather: null, terrain: null, screens: { p1: [], p2: [] }, ...extra });

test('mon.boosts are applied: +2 Atk doubles a physical hit, -1 lowers it, missing boosts change nothing', () => {
  const zero = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
  const d = mon('Gholdengo', 82);
  const plain = estimateDamage(9, mon('Garchomp', 80), d, 'Earthquake');
  const same = estimateDamage(9, mon('Garchomp', 80, { boosts: zero }), d, 'Earthquake');
  const plus2 = estimateDamage(9, mon('Garchomp', 80, { boosts: { ...zero, atk: 2 } }), d, 'Earthquake');
  const minus1 = estimateDamage(9, mon('Garchomp', 80, { boosts: { ...zero, atk: -1 } }), d, 'Earthquake');
  assert.strictEqual(same.maxPct, plain.maxPct);
  assert.ok(Math.abs(plus2.maxPct / plain.maxPct - 2) < 0.05);
  assert.ok(minus1.maxPct < plain.maxPct * 0.7);
  // The DEFENDER's Def boost counts too.
  const bulky = estimateDamage(9, mon('Garchomp', 80), mon('Gholdengo', 82, { boosts: { ...zero, def: 2 } }), 'Earthquake');
  assert.ok(bulky.maxPct < plain.maxPct * 0.6);
});

test('a turn.field snapshot is translated: Sun boosts Fire (Flare Blitz 62-73.6% -> 124.9-147.2%)', () => {
  const koraidon = mon('Koraidon', 64, { side: 'p1', item: 'choiceband', ability: 'orichalcumpulse' });
  const gholdengo = mon('Gholdengo', 82, { side: 'p2' });
  const none = estimateDamage(9, koraidon, gholdengo, 'Flare Blitz', { field: field() });
  const sun = estimateDamage(9, koraidon, gholdengo, 'Flare Blitz', { field: field({ weather: 'SunnyDay' }) });
  assert.deepStrictEqual([none.minPct, none.maxPct], [62, 73.6]);
  assert.deepStrictEqual([sun.minPct, sun.maxPct], [124.9, 147.2]);
  assert.match(sun.desc, /in Sun/);
});

test('a snapshot with no field effects equals passing no field at all', () => {
  const a = mon('Garchomp', 80, { side: 'p1' });
  const d = mon('Gholdengo', 82, { side: 'p2' });
  assert.strictEqual(estimateDamage(9, a, d, 'Earthquake', { field: field() }).maxPct, estimateDamage(9, a, d, 'Earthquake').maxPct);
});

test('screens count only on the defender side and only for the matching category', () => {
  const a = mon('Garchomp', 80, { side: 'p1' });
  const d = mon('Gholdengo', 82, { side: 'p2' });
  const plain = estimateDamage(9, a, d, 'Earthquake').maxPct;
  const reflect = estimateDamage(9, a, d, 'Earthquake', { field: field({ screens: { p1: [], p2: ['Reflect'] } }) }).maxPct;
  const ownSide = estimateDamage(9, a, d, 'Earthquake', { field: field({ screens: { p1: ['Reflect'], p2: [] } }) }).maxPct;
  const lightScreen = estimateDamage(9, a, d, 'Earthquake', { field: field({ screens: { p1: [], p2: ['Light Screen'] } }) }).maxPct;
  assert.ok(Math.abs(reflect / plain - 0.5) < 0.03, `reflect ratio ${reflect / plain}`);
  assert.strictEqual(ownSide, plain); // the attacker's own Reflect does not protect the defender
  assert.strictEqual(lightScreen, plain); // Light Screen does not touch a physical move
  const aurora = estimateDamage(9, a, d, 'Earthquake', { field: field({ screens: { p1: [], p2: ['Aurora Veil'] } }) }).maxPct;
  assert.ok(Math.abs(aurora / plain - 0.5) < 0.03);
});

test('terrain, and unknown weather / terrain ids are handled', () => {
  const a = mon('Miraidon', 80, { side: 'p1' });
  const d = mon('Gholdengo', 82, { side: 'p2' });
  const plain = estimateDamage(9, a, d, 'Thunderbolt').maxPct;
  const terrain = estimateDamage(9, a, d, 'Thunderbolt', { field: field({ terrain: 'Electric Terrain' }) }).maxPct;
  assert.ok(terrain > plain * 1.2);
  // Gholdengo is immune to nothing here, but unknown ids must simply be ignored.
  const odd = estimateDamage(9, a, d, 'Thunderbolt', { field: field({ weather: 'Weird', terrain: 'Weird Terrain' }) }).maxPct;
  assert.strictEqual(odd, plain);
});

test('state.js output feeds straight in: Koraidon in the real Sun turns of the Torkoal log', () => {
  const fsx = require('fs');
  const { buildBattle } = require('../src/core/state');
  const b = buildBattle(fsx.readFileSync(path.join(DIR, 'battle-gen9randombattle-2707578345.log'), 'utf8').split('\n'));
  const t = b.turns[14];
  assert.strictEqual(t.field.weather, 'SunnyDay');
  const [p1, p2] = [t.start.p1, t.start.p2];
  const withSun = estimateDamage(9, p1, p2, 'Flamethrower', { field: t.field });
  const without = estimateDamage(9, p1, p2, 'Flamethrower');
  assert.ok(withSun.maxPct > without.maxPct * 1.4);
});

// --- estimateRange: the defender's ability is not always known ---

const { estimateRange } = require('../src/core/damage');

test('estimateRange: a known ability runs one case and equals estimateDamage', () => {
  const a = mon('Garchomp', 80);
  const d = mon('Gholdengo', 82, { ability: 'goodasgold' });
  const r = estimateRange(9, a, d, 'Earthquake');
  const plain = estimateDamage(9, a, d, 'Earthquake');
  assert.strictEqual(r.minPct, plain.minPct);
  assert.strictEqual(r.maxPct, plain.maxPct);
  assert.strictEqual(r.oppAbilityKnown, true);
  assert.deepStrictEqual(r.abilitiesTried, ['goodasgold']);
});

test('estimateRange: one possible ability is just that case', () => {
  const r = estimateRange(9, mon('Garchomp', 80), mon('Gholdengo', 82), 'Earthquake');
  assert.deepStrictEqual(r.abilitiesTried, ['Good as Gold']);
  assert.strictEqual(r.oppAbilityKnown, false);
  assert.strictEqual(r.maxPct, 93.8);
});

test('estimateRange: unknown ability = worst case for "surely KOs", best case for "might KO"', () => {
  // Heatran has Flash Fire or Flame Body: Flash Fire absorbs Fire moves, so a Fire move
  // can no longer be called a sure KO, but it can still KO.
  const a = mon('Koraidon', 64, { item: 'choiceband', ability: 'orichalcumpulse' });
  const heatran = mon('Heatran', 80, { hpPct: 30 });
  const r = estimateRange(9, a, heatran, 'Flare Blitz');
  assert.deepStrictEqual(r.abilitiesTried, ['Flash Fire', 'Flame Body']);
  assert.strictEqual(r.minPct, 0); // Flash Fire case
  assert.ok(r.maxPct > 0);
  assert.strictEqual(r.guaranteedKo, false);
  assert.strictEqual(r.possibleKo, true);
  // Known to have Flame Body: the same top damage as the best case above.
  const flameBody = estimateRange(9, a, { ...heatran, ability: 'Flame Body' }, 'Flare Blitz');
  assert.strictEqual(flameBody.maxPct, r.maxPct);
});

test('estimateRange: Levitate-only species takes 0 from Earthquake, and Gens 1 and 2 have no ability cases', () => {
  const r = estimateRange(9, mon('Garchomp', 80), mon('Rotom-Wash', 80), 'Earthquake');
  assert.strictEqual(r.maxPct, 0);
  assert.strictEqual(r.possibleKo, false);
  const old = estimateRange(2, mon('Snorlax', 50), mon('Snorlax', 50), 'Body Slam');
  assert.ok(old && old.abilitiesTried.length === 0);
});

test('estimateRange: null for missing Pokémon, unknown move, status move; RangeError for a bad gen', () => {
  const a = mon('Garchomp', 80);
  const d = mon('Gholdengo', 82);
  assert.strictEqual(estimateRange(9, null, d, 'Earthquake'), null);
  assert.strictEqual(estimateRange(9, a, null, 'Earthquake'), null);
  assert.strictEqual(estimateRange(9, a, d, 'Not A Move'), null);
  assert.strictEqual(estimateRange(9, a, d, 'Thunder Wave'), null);
  assert.throws(() => estimateRange(0, a, d, 'Earthquake'), RangeError);
});
