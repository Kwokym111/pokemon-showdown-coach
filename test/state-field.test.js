// Tests for the boost and field tracking in state.js (weather, terrain, screens, stat
// stages). Mini logs for each command, plus facts counted straight from real logs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildBattle } = require('../src/core/state');

const DIR = path.join(__dirname, '..', 'test-data');
const real = (part) => {
  const f = fs.readdirSync(DIR).find((x) => x.includes(part) && x.endsWith('.log'));
  return buildBattle(fs.readFileSync(path.join(DIR, f), 'utf8').split('\n'));
};

const HEADER = [
  '|init|battle', '|gametype|singles', '|player|p1|Alice|1|1000', '|player|p2|Bob|2|1000',
  '|gen|9', '|tier|[Gen 9] Random Battle', '|start',
  '|switch|p1a: Aaa|Aaa, L80|100/100', '|switch|p2a: Bbb|Bbb, L80|100/100',
];
const ZERO = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };

test('weather: set, repeated by [upkeep], cleared by none; snapshots per turn', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1', '|-weather|SunnyDay|[from] ability: Drought|[of] p1a: Aaa',
    '|turn|2', '|-weather|SunnyDay|[upkeep]',
    '|turn|3', '|-weather|none',
    '|turn|4',
  ]);
  assert.strictEqual(b.turns[1].field.weather, null); // not yet when turn 1 began
  assert.strictEqual(b.turns[1].fieldEnd.weather, 'SunnyDay');
  assert.strictEqual(b.turns[2].field.weather, 'SunnyDay');
  assert.strictEqual(b.turns[3].field.weather, 'SunnyDay');
  assert.strictEqual(b.turns[3].fieldEnd.weather, null);
  assert.strictEqual(b.turns[4].field.weather, null);
});

test('terrain starts and ends; a non-terrain field effect does not touch it', () => {
  const b = buildBattle([
    ...HEADER, '|-fieldstart|move: Electric Terrain|[from] ability: Hadron Engine|[of] p2a: Bbb',
    '|turn|1', '|-fieldstart|move: Trick Room|[of] p1a: Aaa',
    '|turn|2', '|-fieldend|move: Electric Terrain',
    '|turn|3',
  ]);
  assert.strictEqual(b.turns[0].fieldEnd.terrain, 'Electric Terrain');
  assert.strictEqual(b.turns[1].field.terrain, 'Electric Terrain');
  assert.strictEqual(b.turns[2].field.terrain, 'Electric Terrain');
  assert.strictEqual(b.turns[3].field.terrain, null);
});

test('screens are tracked per side; hazards are ignored', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1',
    '|-sidestart|p2: Bob|move: Reflect', '|-sidestart|p2: Bob|move: Stealth Rock',
    '|-sidestart|p1: Alice|move: Light Screen', '|-sidestart|p1: Alice|move: Aurora Veil',
    '|turn|2', '|-sideend|p2: Bob|Reflect', '|-sideend|p2: Bob|Stealth Rock',
    '|turn|3',
  ]);
  assert.deepStrictEqual(b.turns[2].field.screens, { p1: ['Light Screen', 'Aurora Veil'], p2: ['Reflect'] });
  assert.deepStrictEqual(b.turns[3].field.screens, { p1: ['Light Screen', 'Aurora Veil'], p2: [] });
});

test('boosts: boost, unboost, setboost, clamped to +-6', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1',
    '|-boost|p1a: Aaa|atk|2', '|-boost|p1a: Aaa|spe|1', '|-unboost|p1a: Aaa|atk|1',
    '|-setboost|p2a: Bbb|atk|6', '|-boost|p2a: Bbb|atk|2',
    '|turn|2',
  ]);
  assert.deepStrictEqual(b.turns[2].start.p1.boosts, { ...ZERO, atk: 1, spe: 1 });
  assert.strictEqual(b.turns[2].start.p2.boosts.atk, 6);
});

test('boosts: clear, clearpositive, clearnegative, invert, clearall, swap, copy', () => {
  const boostLines = (mon, stats) => stats.map(([s, n]) => `|${n > 0 ? '-boost' : '-unboost'}|${mon}|${s}|${Math.abs(n)}`);
  const run = (extra) => buildBattle([
    ...HEADER, '|turn|1',
    ...boostLines('p1a: Aaa', [['atk', 2], ['def', -1]]),
    ...boostLines('p2a: Bbb', [['spa', 3]]),
    ...extra, '|turn|2',
  ]).turns[2].start;

  assert.deepStrictEqual(run(['|-clearboost|p1a: Aaa']).p1.boosts, ZERO);
  assert.deepStrictEqual(run(['|-clearpositiveboost|p1a: Aaa|p2a: Bbb|move: Spectral Thief']).p1.boosts, { ...ZERO, def: -1 });
  assert.deepStrictEqual(run(['|-clearnegativeboost|p1a: Aaa']).p1.boosts, { ...ZERO, atk: 2 });
  assert.deepStrictEqual(run(['|-invertboost|p1a: Aaa']).p1.boosts, { ...ZERO, atk: -2, def: 1 });
  const all = run(['|-clearallboost']);
  assert.deepStrictEqual([all.p1.boosts, all.p2.boosts], [ZERO, ZERO]);
  const swap = run(['|-swapboost|p1a: Aaa|p2a: Bbb|atk, spa']);
  assert.deepStrictEqual(swap.p1.boosts, { ...ZERO, spa: 3, def: -1 });
  assert.deepStrictEqual(swap.p2.boosts, { ...ZERO, atk: 2 });
  assert.deepStrictEqual(run(['|-copyboost|p2a: Bbb|p1a: Aaa']).p2.boosts, { ...ZERO, atk: 2, def: -1 });
});

test('boosts end when the Pokémon switches out or faints', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1', '|-boost|p1a: Aaa|atk|2', '|-boost|p2a: Bbb|atk|2',
    '|turn|2', '|switch|p1a: Ccc|Ccc, L80|100/100', '|faint|p2a: Bbb',
    '|turn|3', '|switch|p1a: Aaa|Aaa, L80|100/100', '|switch|p2a: Ddd|Ddd, L80|100/100',
    '|turn|4',
  ]);
  assert.strictEqual(b.turns[3].start.p1.boosts.atk, 0); // Ccc
  assert.strictEqual(b.turns[4].start.p1.boosts.atk, 0); // Aaa came back clean
  assert.strictEqual(b.turns[4].start.p2.boosts.atk, 0);
});

test('a stored snapshot is not changed by later events', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1', '|-boost|p1a: Aaa|atk|1', '|-weather|Sandstorm',
    '|turn|2', '|-boost|p1a: Aaa|atk|2', '|-weather|none',
    '|turn|3',
  ]);
  assert.strictEqual(b.turns[2].start.p1.boosts.atk, 1);
  assert.strictEqual(b.turns[2].end.p1.boosts.atk, 3);
  assert.strictEqual(b.turns[1].end.p1.boosts.atk, 1);
  assert.strictEqual(b.turns[2].field.weather, 'Sandstorm');
  assert.strictEqual(b.turns[2].fieldEnd.weather, null);
});

test('the modelled effects are still in the event list, in the same shape as before', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1', '|-boost|p1a: Aaa|atk|2', '|-weather|SunnyDay|[upkeep]',
    '|-fieldstart|move: Grassy Terrain', '|-sidestart|p2: Bob|move: Reflect', '|-clearallboost',
  ]);
  const ev = b.turns[1].events;
  assert.deepStrictEqual(ev.map((e) => e.type), ['boost', 'weather', 'fieldstart', 'sidestart', 'clearallboost']);
  assert.deepStrictEqual(ev[0].args, ['p1a: Aaa', 'atk', '2']);
  assert.strictEqual(ev[1].kw.upkeep, true);
  assert.deepStrictEqual(b.warnings.unknownCommands, {});
});

test('real log: Drought sun starts at the end of turn 12; its [upkeep] lines keep it', () => {
  const b = real('2707578345');
  assert.strictEqual(b.turns[12].field.weather, null);
  assert.strictEqual(b.turns[12].fieldEnd.weather, 'SunnyDay');
  for (const n of [13, 14, 15, 16]) assert.strictEqual(b.turns[n].field.weather, 'SunnyDay', `turn ${n}`);
});

test('real log: Electric Terrain from the lead-in until the end of turn 5', () => {
  const b = real('2707347511');
  for (const n of [1, 2, 3, 4, 5]) assert.strictEqual(b.turns[n].field.terrain, 'Electric Terrain', `turn ${n}`);
  assert.strictEqual(b.turns[5].fieldEnd.terrain, null);
  assert.strictEqual(b.turns[6].field.terrain, null);
});

test('real log: Rhyperior at the start of turn 14 is atk+1 spa+2 spe+2 (Weakness Policy, a boost, an unboost)', () => {
  const b = real('2707352165');
  assert.strictEqual(b.turns[14].start.p2.name, 'Rhyperior');
  assert.deepStrictEqual(b.turns[14].start.p2.boosts, { ...ZERO, atk: 1, spa: 2, spe: 2 });
});

test('every real log: boosts stay within -6..6 and every turn has a field snapshot', () => {
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.log'))) {
    const b = buildBattle(fs.readFileSync(path.join(DIR, f), 'utf8').split('\n'));
    for (const t of b.turns) {
      assert.ok(t.field && t.fieldEnd, `${f} turn ${t.turn}`);
      for (const side of ['p1', 'p2']) {
        for (const snap of [t.start && t.start[side], t.end && t.end[side]]) {
          if (!snap) continue;
          for (const v of Object.values(snap.boosts)) assert.ok(v >= -6 && v <= 6, `${f} turn ${t.turn}`);
        }
      }
    }
  }
});
