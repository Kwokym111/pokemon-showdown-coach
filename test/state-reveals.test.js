// Tests for how state.js learns items and abilities from "[from] item: X" / "[from] ability: X"
// tags and "-activate|mon|ability: X" lines. The opponent's set is hidden, so these side
// effects are how a log reveals it.

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

// A request for p1 so that b.me is 'p1' and the log must not overwrite what it says.
const REQUEST = '|request|' + JSON.stringify({
  side: { name: 'Alice', id: 'p1', pokemon: [{ ident: 'p1: Aaa', details: 'Aaa, L80', condition: '100/100', active: true, item: 'leftovers', ability: 'pressure', moves: ['tackle'] }] },
  active: [{ moves: [{ move: 'Tackle', id: 'tackle', pp: 10, maxpp: 10 }] }],
});

test('Life Orb recoil and Leftovers healing reveal the item of the Pokémon on that line', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1',
    '|move|p2a: Bbb|Tackle|p1a: Aaa', '|-damage|p1a: Aaa|80/100', '|-damage|p2a: Bbb|90/100|[from] item: Life Orb',
    '|turn|2', '|-heal|p1a: Aaa|85/100|[from] item: Leftovers',
    '|turn|3',
  ]);
  assert.strictEqual(b.turns[1].start.p2.item, null); // not known when turn 1 began
  assert.strictEqual(b.turns[2].start.p2.item, 'Life Orb');
  assert.strictEqual(b.turns[2].start.p1.item, null);
  assert.strictEqual(b.turns[3].start.p1.item, 'Leftovers');
});

test('[of] decides the owner: Rocky Helmet belongs to the defender, not the damaged attacker', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1',
    '|move|p1a: Aaa|Tackle|p2a: Bbb', '|-damage|p2a: Bbb|70/100',
    '|-damage|p1a: Aaa|84/100|[from] item: Rocky Helmet|[of] p2a: Bbb',
    '|turn|2',
  ]);
  assert.strictEqual(b.turns[2].start.p2.item, 'Rocky Helmet');
  assert.strictEqual(b.turns[2].start.p1.item, null);
});

test('abilities: weather setter, Intimidate victim line and -activate / -start', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1',
    '|-weather|SunnyDay|[from] ability: Drought|[of] p2a: Bbb',
    '|-unboost|p2a: Bbb|atk|1|[from] ability: Intimidate|[of] p1a: Aaa',
    '|turn|2', '|-activate|p2a: Bbb|ability: Flash Fire',
    '|turn|3',
  ]);
  assert.strictEqual(b.turns[2].start.p1.ability, 'Intimidate');
  assert.strictEqual(b.turns[2].start.p2.ability, 'Drought');
  assert.strictEqual(b.turns[3].start.p2.ability, 'Flash Fire'); // the latest reveal wins
});

test('Frisk: the item goes to the frisked Pokémon, the ability to the one that frisked', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1',
    '|-item|p2a: Bbb|Life Orb|[from] ability: Frisk|[of] p1a: Aaa',
    '|turn|2',
  ]);
  assert.strictEqual(b.turns[2].start.p2.item, 'Life Orb');
  assert.strictEqual(b.turns[2].start.p1.ability, 'Frisk');
});

test('my own side comes from |request| and is not overwritten by log tags', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1', REQUEST,
    '|-damage|p1a: Aaa|80/100|[from] item: Life Orb', '|-weather|Sandstorm|[from] ability: Sand Stream|[of] p1a: Aaa',
    '|turn|2', REQUEST,
  ]);
  assert.strictEqual(b.me, 'p1');
  assert.strictEqual(b.turns[2].start.p1.item, 'leftovers'); // the request's value
  assert.strictEqual(b.turns[2].start.p1.ability, 'pressure');
  // The opponent is still learned from the same kind of line.
  const c = buildBattle([...HEADER, '|turn|1', REQUEST, '|-damage|p2a: Bbb|90/100|[from] item: Life Orb', '|turn|2']);
  assert.strictEqual(c.turns[2].start.p2.item, 'Life Orb');
});

test('a consumed item is cleared by -enditem and kept in lostItem; the tag does not bring it back', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1',
    '|-boost|p2a: Bbb|atk|2|[from] item: Weakness Policy', '|-enditem|p2a: Bbb|Weakness Policy',
    '|turn|2',
  ]);
  assert.strictEqual(b.turns[2].start.p2.item, null);
  assert.strictEqual(b.turns[2].start.p2.lostItem, 'Weakness Policy');
});

test('lines with [from] move: / no owner are ignored, and the events are unchanged', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1',
    '|-heal|p2a: Bbb|100/100|[from] move: Recover', '|-weather|none',
    '|-fieldstart|move: Electric Terrain|[from] ability: Hadron Engine|[of] p2a: Bbb',
    '|turn|2',
  ]);
  assert.strictEqual(b.turns[2].start.p2.item, null);
  assert.strictEqual(b.turns[2].start.p2.ability, 'Hadron Engine');
  assert.deepStrictEqual(b.turns[1].events.map((e) => e.type), ['heal', 'weather', 'fieldstart']);
});

test('real log: Espeon Life Orb (turn 3) and Torkoal Drought (turn 13) become known at the right turn', () => {
  const b = real('2707578345');
  assert.strictEqual(b.me, 'p2');
  const firstKnown = (name, key) => b.turns.find((t) => t.start && t.start.p1 && t.start.p1.name === name && t.start.p1[key]);
  assert.strictEqual(firstKnown('Espeon', 'item').turn, 3);
  assert.strictEqual(firstKnown('Espeon', 'item').start.p1.item, 'Life Orb');
  assert.strictEqual(firstKnown('Torkoal', 'ability').turn, 13);
  assert.strictEqual(firstKnown('Torkoal', 'ability').start.p1.ability, 'Drought');
});

test('real logs: nothing about the opponent is known at the start of the battle unless announced', () => {
  const b = real('2707357132'); // p2 is me; no opponent reveal tags in this short game
  const opp = b.me === 'p1' ? 'p2' : 'p1';
  for (const t of b.turns) {
    if (t.start && t.start[opp]) assert.strictEqual(t.start[opp].item, null);
  }
});
