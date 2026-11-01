// Unit tests for the line-level parser. Inputs are copied from real logs in test-data/.

const test = require('node:test');
const assert = require('node:assert');
const { parseLine, parseIdent, parseDetails, parseCondition, stripRank } = require('../src/core/parser');

test('parseLine: plain line', () => {
  assert.deepStrictEqual(parseLine('|switch|p2a: Slither Wing|Slither Wing, L81|270/270'), {
    cmd: 'switch',
    args: ['p2a: Slither Wing', 'Slither Wing, L81', '270/270'],
    kw: {},
  });
});

test('parseLine: [from] and [of] become kw, not arguments', () => {
  const r = parseLine('|-heal|p1a: Comfey|34/100 psn|[from] drain|[of] p2a: Sunflora');
  assert.deepStrictEqual(r.args, ['p1a: Comfey', '34/100 psn']);
  assert.deepStrictEqual(r.kw, { from: 'drain', of: 'p2a: Sunflora' });
});

test('parseLine: bare flags like [miss] and [still] become true', () => {
  const miss = parseLine('|move|p1a: Sceptile|Focus Blast|p2a: Magnezone|[miss]');
  assert.deepStrictEqual(miss.args, ['p1a: Sceptile', 'Focus Blast', 'p2a: Magnezone']);
  assert.strictEqual(miss.kw.miss, true);

  // Empty target stays an (empty) argument so positions do not shift.
  const still = parseLine('|move|p1a: Sceptile|Leech Seed||[still]');
  assert.deepStrictEqual(still.args, ['p1a: Sceptile', 'Leech Seed', '']);
  assert.strictEqual(still.kw.still, true);
});

test('parseLine: "[Gen 9] Random Battle" is a tier name, not a kw flag', () => {
  const r = parseLine('|tier|[Gen 9] Random Battle');
  assert.deepStrictEqual(r.args, ['[Gen 9] Random Battle']);
  assert.deepStrictEqual(r.kw, {});
});

test('parseLine: request JSON is kept whole, even if it contains "|"', () => {
  const r = parseLine('|request|{"side":{"id":"p2","name":"a|b"},"wait":true}');
  assert.strictEqual(r.cmd, 'request');
  assert.strictEqual(r.args[0].side.name, 'a|b');
  assert.strictEqual(r.args[0].side.id, 'p2');
});

test('parseLine: noise and blank lines return null', () => {
  for (const l of ['', '|', '|t:|1793472923', '|inactive|Battle timer is ON', '|raw|<div>rating</div>', 'not a protocol line']) {
    assert.strictEqual(parseLine(l), null, l);
  }
});

test('parseLine: a damaged request is skipped instead of throwing', () => {
  assert.strictEqual(parseLine('|request|{"side":'), null);
});

test('parseIdent: slot, no slot, spaces and colons in names', () => {
  assert.deepStrictEqual(parseIdent('p1a: Vigoroth'), { side: 'p1', slot: 'a', name: 'Vigoroth' });
  assert.deepStrictEqual(parseIdent('p2: cool213'), { side: 'p2', slot: null, name: 'cool213' });
  assert.deepStrictEqual(parseIdent('p2a: Mr. Mime: Jr'), { side: 'p2', slot: 'a', name: 'Mr. Mime: Jr' });
  assert.strictEqual(parseIdent('Sandstorm'), null);
});

test('parseDetails: level, gender, tera, and level 100 when omitted', () => {
  assert.deepStrictEqual(parseDetails('Vigoroth, L85, M'), { species: 'Vigoroth', level: 85, gender: 'M', tera: null });
  assert.deepStrictEqual(parseDetails('Slither Wing, L81'), { species: 'Slither Wing', level: 81, gender: null, tera: null });
  assert.deepStrictEqual(parseDetails('Ceruledge, L88, F, tera:Ghost'), { species: 'Ceruledge', level: 88, gender: 'F', tera: 'Ghost' });
  assert.strictEqual(parseDetails('Pikachu').level, 100);
});

test('parseCondition: real HP, percent HP, status, fainted', () => {
  assert.deepStrictEqual(parseCondition('266/266'), { hp: 266, maxHp: 266, status: null, fainted: false });
  assert.deepStrictEqual(parseCondition('85/100'), { hp: 85, maxHp: 100, status: null, fainted: false });
  assert.deepStrictEqual(parseCondition('120/266 par'), { hp: 120, maxHp: 266, status: 'par', fainted: false });
  assert.deepStrictEqual(parseCondition('0 fnt'), { hp: 0, maxHp: null, status: null, fainted: true });
  assert.strictEqual(parseCondition('garbage'), null);
});

test('stripRank removes rank symbols but keeps names with spaces', () => {
  assert.strictEqual(stripRank('☆cool213'), 'cool213');
  assert.strictEqual(stripRank('‽anon Opponent'), 'anon Opponent');
  assert.strictEqual(stripRank('cool213'), 'cool213');
});
