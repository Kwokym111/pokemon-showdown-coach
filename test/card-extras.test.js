// test/card-extras.test.js: the avatars and the "who was ahead" series for the end-of-game card.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { cardExtras, avatarsOf, buildEvalSeries } = require('../src/core/card-extras');

// A tiny 2-Pokemon-per-side battle. I am p2 (A and B); the opponent is p1 (X, then a hidden Y).
const request = JSON.stringify({
  side: { id: 'p2', name: 'me', pokemon: [
    { ident: 'p2: A', condition: '100/100', active: true },
    { ident: 'p2: B', condition: '100/100', active: false },
  ] },
});
const LOG = [
  '|init|battle', '|player|p1|them|steven|1000', '|player|p2|me|265|1000',
  '|teamsize|p1|2', '|teamsize|p2|2',
  `|request|${request}`,
  '|switch|p1a: X|X, L80|100/100', '|switch|p2a: A|A, L80|200/200',
  '|turn|1',
  '|move|p2a: A|Tackle|p1a: X', '|-damage|p1a: X|50/100',
  '|turn|2',
  '|move|p1a: X|Tackle|p2a: A', '|-damage|p2a: A|40/200',
  '|move|p2a: A|Tackle|p1a: X', '|-damage|p1a: X|0 fnt', '|faint|p1a: X',
  '|win|me',
];

test('evalSeries: one point per turn, from my point of view', () => {
  // turn 0: 200 vs 200 -> 0.  After turn 1: X is at 50, so (200 - 150) / 2 = 25.
  // After turn 2: A is at 20 and X has fainted, the hidden Y counts as full: (120 - 100) / 2 = 10.
  assert.deepStrictEqual(buildEvalSeries(LOG, 'p2'), [
    { turn: 0, eval: 0 }, { turn: 1, eval: 25 }, { turn: 2, eval: 10 },
  ]);
});

test('evalSeries: the other side sees the mirror image', () => {
  const mine = buildEvalSeries(LOG, 'p2').map((p) => p.eval);
  const theirs = buildEvalSeries(LOG, 'p1').map((p) => p.eval);
  assert.strictEqual(theirs[0], 0);
  assert.strictEqual(theirs[1], -25); // without a |request| of their own their team is "unseen = full", same as mine for me
});

test('evalSeries: healing, percentages and fainting are all read', () => {
  const lines = [...LOG.slice(0, 9), '|-heal|p1a: X|100/100', '|turn|2', '|faint|p2a: A', '|turn|3'];
  const s = buildEvalSeries(lines, 'p2');
  assert.strictEqual(s[1].eval, 0);          // X healed back to full
  assert.strictEqual(s[2].eval, -50);        // A fainted: (100 - 200) / 2
});

test('evalSeries: nothing to draw when I am not a player, or the input is junk', () => {
  assert.deepStrictEqual(buildEvalSeries(LOG, null), []);
  assert.deepStrictEqual(buildEvalSeries(LOG, 'p3'), []);
  assert.deepStrictEqual(buildEvalSeries('not an array', 'p1'), []);
  assert.doesNotThrow(() => buildEvalSeries([null, 42, '', '|', '|turn|', '|-damage|', '|switch|??|x|y', '|request|{broken'], 'p2'));
});

test('evalSeries: a game with no turns gives no graph', () => {
  assert.deepStrictEqual(buildEvalSeries(['|init|battle', '|win|x'], 'p2'), []);
});

test('avatarsOf: picks my avatar and the opponent\'s, whichever side I am', () => {
  const battle = { me: 'p2', players: { p1: { name: 'them', avatar: 'steven' }, p2: { name: 'me', avatar: '265' } } };
  assert.deepStrictEqual(avatarsOf(battle), { me: '265', opponent: 'steven' });
  assert.deepStrictEqual(avatarsOf({ ...battle, me: 'p1' }), { me: 'steven', opponent: '265' });
});

test('avatarsOf: missing information becomes null, never an error', () => {
  assert.deepStrictEqual(avatarsOf({ me: null, players: {} }), { me: null, opponent: null });
  assert.deepStrictEqual(avatarsOf({ me: 'p1', players: { p1: { name: 'a', avatar: null } } }), { me: null, opponent: null });
  assert.deepStrictEqual(avatarsOf(undefined), { me: null, opponent: null });
});

test('cardExtras: both pieces together, as main.js adds them to the review', () => {
  const battle = { me: 'p2', players: { p1: { avatar: 'steven' }, p2: { avatar: '265' } } };
  const extras = cardExtras(battle, LOG);
  assert.deepStrictEqual(Object.keys(extras).sort(), ['avatars', 'evalSeries']);
  assert.strictEqual(extras.avatars.me, '265');
  assert.strictEqual(extras.evalSeries.length, 3);
  assert.doesNotThrow(() => JSON.stringify(extras)); // only plain data crosses IPC
});
