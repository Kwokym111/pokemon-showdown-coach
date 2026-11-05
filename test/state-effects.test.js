// Tests for volatile effects (|-start| / |-end|) and side effects (hazards) in state.js.
// Mini logs for each command, plus real logs from test-data/.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildBattle } = require('../src/core/state');

const DIR = path.join(__dirname, '..', 'test-data');
const realLines = (part) => {
  const f = fs.readdirSync(DIR).find((x) => x.includes(part) && x.endsWith('.log'));
  return fs.readFileSync(path.join(DIR, f), 'utf8').split('\n');
};

const HEADER = [
  '|init|battle', '|gametype|singles', '|player|p1|Alice|1|1000', '|player|p2|Bob|2|1000',
  '|gen|9', '|tier|[Gen 9] Random Battle', '|start',
  '|switch|p1a: Aaa|Aaa, L80|100/100', '|switch|p2a: Bbb|Bbb, L80|100/100',
];
const activeEnd = (b, side) => b.turns[b.turns.length - 1].end[side];

test('volatiles: |-start| adds the effect name (with or without "move: "), |-end| removes it', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1',
    '|-start|p2a: Bbb|move: Leech Seed',
    '|-start|p1a: Aaa|Substitute',
    '|-start|p1a: Aaa|move: Heal Block',
    '|-end|p1a: Aaa|move: Heal Block',
  ]);
  assert.deepStrictEqual(activeEnd(b, 'p2').volatiles, ['Leech Seed']);
  assert.deepStrictEqual(activeEnd(b, 'p1').volatiles, ['Substitute']);
});

test('volatiles: extra arguments are ignored (Disable does not leak which move)', () => {
  const b = buildBattle([...HEADER, '|turn|1', '|-start|p2a: Bbb|Disable|Volt Switch|[from] ability: Cursed Body']);
  assert.deepStrictEqual(activeEnd(b, 'p2').volatiles, ['Disable']);
});

test('volatiles: typechange is not an effect (it is modelled as typeOverride)', () => {
  const b = buildBattle([...HEADER, '|turn|1', '|-start|p2a: Bbb|typechange|Bug|[from] ability: Libero']);
  assert.deepStrictEqual(activeEnd(b, 'p2').volatiles, []);
  assert.deepStrictEqual(activeEnd(b, 'p2').typeOverride, ['Bug']);
});

test('volatiles: counters replace each other, a repeated start does not duplicate', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1',
    '|-start|p1a: Aaa|perish3', '|-start|p1a: Aaa|perish2',
    '|-start|p2a: Bbb|move: Taunt', '|-start|p2a: Bbb|move: Taunt',
  ]);
  assert.deepStrictEqual(activeEnd(b, 'p1').volatiles, ['perish2']);
  assert.deepStrictEqual(activeEnd(b, 'p2').volatiles, ['Taunt']);
  // Ending by the base name removes the counter version too.
  const c = buildBattle([...HEADER, '|turn|1', '|-start|p1a: Aaa|Stockpile2', '|-end|p1a: Aaa|Stockpile']);
  assert.deepStrictEqual(activeEnd(c, 'p1').volatiles, []);
});

test('volatiles: ending something never started is harmless, and |-end| stays a generic event', () => {
  const b = buildBattle([...HEADER, '|turn|1', '|-end|p2a: Bbb|Quark Drive|[silent]']);
  assert.deepStrictEqual(activeEnd(b, 'p2').volatiles, []);
  // review.js reads these generic 'end' events, so the new handler must keep recording them.
  assert.ok(b.turns[1].events.some((e) => e.type === 'end' && e.args[1] === 'Quark Drive'));
});

test('volatiles end when the Pokémon switches out or faints', () => {
  const out = buildBattle([
    ...HEADER, '|turn|1', '|-start|p2a: Bbb|move: Leech Seed',
    '|turn|2', '|switch|p2a: Ccc|Ccc, L80|100/100', '|switch|p2a: Bbb|Bbb, L80|90/100',
  ]);
  assert.deepStrictEqual(activeEnd(out, 'p2').volatiles, []); // Bbb came back without it

  const fnt = buildBattle([
    ...HEADER, '|turn|1', '|-start|p1a: Aaa|Substitute', '|faint|p1a: Aaa',
  ]);
  assert.deepStrictEqual(activeEnd(fnt, 'p1').volatiles, []);
});

test('volatiles: snapshots are copies (a later change does not alter an earlier turn)', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1', '|-start|p2a: Bbb|move: Leech Seed',
    '|turn|2', '|-end|p2a: Bbb|move: Leech Seed', '|turn|3',
  ]);
  assert.deepStrictEqual(b.turns[2].start.p2.volatiles, ['Leech Seed']);
  assert.deepStrictEqual(b.turns[3].start.p2.volatiles, []);
  assert.deepStrictEqual(b.turns[1].end.p2.volatiles, ['Leech Seed']);
});

test('side effects: hazards per side, Spikes stack layers, |-sideend| clears, screens stay in screens', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1',
    '|-sidestart|p2: Bob|move: Stealth Rock',
    '|-sidestart|p2: Bob|Spikes', '|-sidestart|p2: Bob|Spikes',
    '|-sidestart|p1: Alice|move: Toxic Spikes',
    '|-sidestart|p1: Alice|move: Reflect',
    '|turn|2',
    '|-sideend|p2: Bob|Spikes|[from] move: Rapid Spin|[of] p2a: Bbb',
    '|turn|3',
  ]);
  const t1 = b.turns[1].fieldEnd;
  assert.deepStrictEqual(t1.sideEffects.p2, [{ name: 'Stealth Rock', layers: 1 }, { name: 'Spikes', layers: 2 }]);
  assert.deepStrictEqual(t1.sideEffects.p1, [{ name: 'Toxic Spikes', layers: 1 }]);
  assert.deepStrictEqual(t1.screens, { p1: ['Reflect'], p2: [] }); // unchanged behaviour for damage.js
  // Spikes were removed in turn 2, Stealth Rock stays.
  assert.deepStrictEqual(b.turns[3].field.sideEffects.p2, [{ name: 'Stealth Rock', layers: 1 }]);
  // The snapshot taken at the start of turn 2 still has both layers (copies, not shared).
  assert.deepStrictEqual(b.turns[2].field.sideEffects.p2[1], { name: 'Spikes', layers: 2 });
});

test('real logs: Sceptile (me) has Substitute, then Heal Block twice; Gothitelle gets Leech Seeded', () => {
  const lines = realLines('2707352165');
  const at = (prefix) => lines.findIndex((l) => l.startsWith(prefix));
  const cutVolatiles = (idx, side) => activeEnd(buildBattle(lines.slice(0, idx + 1)), side).volatiles;

  assert.deepStrictEqual(cutVolatiles(at('|-start|p1a: Sceptile|Substitute'), 'p1'), ['Substitute']);
  assert.deepStrictEqual(cutVolatiles(at('|-end|p1a: Sceptile|Substitute'), 'p1'), []);
  assert.deepStrictEqual(cutVolatiles(at('|-start|p1a: Sceptile|move: Heal Block'), 'p1'), ['Heal Block']);
  assert.deepStrictEqual(cutVolatiles(at('|-end|p1a: Sceptile|move: Heal Block'), 'p1'), []);
  assert.deepStrictEqual(cutVolatiles(at('|-start|p2a: Gothitelle|move: Leech Seed'), 'p2'), ['Leech Seed']);
});

test('real logs: Stealth Rock and Toxic Spikes land on the side the log names', () => {
  const lines = realLines('2707347511');
  const full = buildBattle(lines);
  const last = full.turns[full.turns.length - 1].fieldEnd.sideEffects;
  const all = [...last.p1, ...last.p2].map((e) => e.name);
  assert.ok(all.includes('Toxic Spikes') && all.includes('Stealth Rock'));
  // Both lines say "p1: cool213", so both are on p1's side.
  assert.ok(last.p1.some((e) => e.name === 'Stealth Rock'));
});
