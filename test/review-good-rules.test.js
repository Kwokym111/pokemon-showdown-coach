// Tests for docs/task-good-moment-rules.md: the new `setup-paid-off` rule and the "2 knockouts
// that end the game" case of `ko-streak`. Real logs for the expected results, and small
// hand-written battles for the "does NOT fire" cases.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildBattle } = require('../src/core/state');
const { buildReview } = require('../src/core/review');
const { getMove } = require('../src/core/data');

const reviewOf = (file) => buildReview(
  buildBattle(fs.readFileSync(path.join(__dirname, '..', 'test-data', file), 'utf8').split(/\r?\n/)),
  { room: file },
);
const rules = (r) => r.moments.map((m) => [m.turn, m.rule, m.label, m.mon]);

// ---------------------------------------------------------------------------
// The real logs
// ---------------------------------------------------------------------------

test('no_moments.log: Blaziken\'s Swords Dance paid off (T21) and Bruxish\'s last knockout won the game (T25)', () => {
  const r = reviewOf('no_moments.log');
  assert.deepStrictEqual(rules(r), [[21, 'setup-paid-off', 'good', 'Blaziken'], [25, 'ko-streak', 'great', 'Bruxish']]);

  const [paid, streak] = r.moments;
  assert.deepStrictEqual(paid.facts.setupMoves, [{ turn: 18, move: 'Swords Dance' }, { turn: 20, move: 'Swords Dance' }]);
  assert.deepStrictEqual(paid.facts.kos.map((k) => [k.turn, k.move]), [[19, 'Close Combat'], [21, 'Flare Blitz']]);
  assert.strictEqual(paid.facts.knowable, true);
  assert.match(paid.facts.whyKnowable, /^Blaziken used Swords Dance on turns 18 and 20, then knocked out /);

  assert.strictEqual(streak.facts.count, 2);
  assert.strictEqual(streak.facts.endedGame, true);
  assert.strictEqual(streak.facts.endedByForfeit, false);
  assert.strictEqual(streak.facts.setUpFirst, false); // Bellossom's Quiver Dance is a different stay, and Bruxish never set up
  assert.match(streak.facts.whyKnowable, /and its last knockout won the game$/);
});

test('Darkrai (opponent forfeited): still one moment, the T21 ko-streak, now marked setUpFirst', () => {
  const r = reviewOf('battle-gen9randombattle-2709149901.log');
  const darkrai = r.moments.filter((m) => m.mon === 'Darkrai');
  assert.deepStrictEqual(darkrai.map((m) => [m.turn, m.rule]), [[21, 'ko-streak']]);
  assert.strictEqual(darkrai[0].facts.setUpFirst, true);
  assert.deepStrictEqual(darkrai[0].facts.setupMoves, [{ turn: 18, move: 'Nasty Plot' }]);
  assert.strictEqual(darkrai[0].facts.endedByForfeit, true);
  assert.strictEqual(r.moments.some((m) => m.rule === 'setup-paid-off'), false);
});

// ---------------------------------------------------------------------------
// Which moves count as setup (data-driven)
// ---------------------------------------------------------------------------

test('data: setup moves are Status moves aimed at self with positive boosts; damaging boost moves are not', () => {
  const isSetup = (gen, n) => { const m = getMove(gen, n); return m.category === 'Status' && m.target === 'self' && !!m.boosts && Object.values(m.boosts).some((v) => v > 0); };
  for (const n of ['Swords Dance', 'Nasty Plot', 'Dragon Dance', 'Quiver Dance', 'Calm Mind', 'Shell Smash', 'Bulk Up', 'Agility']) assert.ok(isSetup(9, n), n);
  for (const n of ['Flame Charge', 'Trailblaze', 'Belly Drum', 'Howl']) assert.ok(!isSetup(9, n), n); // Belly Drum is covered by CONFIG.extraSetupMoves
  assert.ok(!isSetup(8, 'Power-Up Punch')); // not in the Gen 9 data, so check it in Gen 8
});

// ---------------------------------------------------------------------------
// A tiny battle builder. I am p1 (Alice), the opponent is p2 (Bob).
// ---------------------------------------------------------------------------
function request(moves) {
  return {
    active: [{ moves: moves.map((m) => ({ move: m, id: m.toLowerCase().replace(/[^a-z0-9]/g, ''), pp: 10, maxpp: 10 })) }],
    side: {
      name: 'Alice', id: 'p1',
      pokemon: [['Snorlax', '100/100'], ['Venusaur', '100/100']].map(([n, c], i) => ({ ident: `p1: ${n}`, details: `${n}, L80`, condition: c, active: i === 0, moves: ['tackle'] })),
    },
  };
}

// `turns` is a list of line arrays (one per turn). Pass `end` lines to finish the battle.
function game(turns, { moves = ['Swords Dance', 'Body Slam'], end = [] } = {}) {
  const lines = [
    '|init|battle', '|gametype|singles', '|player|p1|Alice|1|1000', '|player|p2|Bob|2|1000',
    '|gen|9', '|tier|[Gen 9] Random Battle', '|start',
    '|switch|p1a: Snorlax|Snorlax, L80|100/100', '|switch|p2a: Charizard|Charizard, L80|100/100',
  ];
  turns.forEach((body, i) => lines.push(`|turn|${i + 1}`, `|request|${JSON.stringify(request(moves))}`, ...body));
  lines.push(...end);
  return buildReview(buildBattle(lines), { room: 'mini' });
}

const swordsDance = ['|move|p1a: Snorlax|Swords Dance|p1a: Snorlax', '|-boost|p1a: Snorlax|atk|2'];
// Snorlax knocks out `foe` and the opponent sends in `next` (or has nothing left).
const ko = (move, foe, next) => [
  `|move|p1a: Snorlax|${move}|p2a: ${foe}`, `|-damage|p2a: ${foe}|0 fnt`, `|faint|p2a: ${foe}`, '|upkeep',
  ...(next ? [`|switch|p2a: ${next}|${next}, L80|100/100`] : []),
];

test('setup-paid-off: Swords Dance, then two knockouts in the same stay (hand-built)', () => {
  const r = game([swordsDance, ko('Body Slam', 'Charizard', 'Moltres'), ko('Body Slam', 'Moltres', 'Gengar')]);
  assert.deepStrictEqual(rules(r), [[3, 'setup-paid-off', 'good', 'Snorlax']]);
  assert.deepStrictEqual(r.moments[0].facts.setupMoves, [{ turn: 1, move: 'Swords Dance' }]);
});

test('setup-paid-off: does NOT fire with only one knockout after the setup', () => {
  const r = game([swordsDance, ko('Body Slam', 'Charizard', 'Moltres')]);
  assert.deepStrictEqual(r.moments, []);
});

test('setup-paid-off: knockouts BEFORE the setup do not count', () => {
  const r = game([ko('Body Slam', 'Charizard', 'Moltres'), ko('Body Slam', 'Moltres', 'Gengar'), swordsDance]);
  assert.deepStrictEqual(r.moments.filter((m) => m.rule === 'setup-paid-off'), []);
});

test('setup-paid-off: a setup move that failed (no boost line) does not count', () => {
  const failed = ['|move|p1a: Snorlax|Swords Dance|p1a: Snorlax', '|-fail|p1a: Snorlax'];
  const r = game([failed, ko('Body Slam', 'Charizard', 'Moltres'), ko('Body Slam', 'Moltres', 'Gengar')]);
  assert.deepStrictEqual(r.moments, []);
});

test('setup-paid-off: Speed Boost at the end of the turn is not a setup move working', () => {
  // Agility fails, then the opponent moves, then Speed Boost (an ability, no event of its own) gives +1 Spe.
  const t1 = ['|move|p1a: Snorlax|Agility|p1a: Snorlax', '|-fail|p1a: Snorlax', '|move|p2a: Charizard|Flamethrower|p1a: Snorlax', '|-damage|p1a: Snorlax|90/100', '|-ability|p1a: Snorlax|Speed Boost|boost', '|-boost|p1a: Snorlax|spe|1'];
  const r = game([t1, ko('Body Slam', 'Charizard', 'Moltres'), ko('Body Slam', 'Moltres', 'Gengar')], { moves: ['Agility', 'Body Slam'] });
  assert.deepStrictEqual(r.moments, []);
});

test('setup-paid-off: a boost from a damaging move (Flame Charge, Trailblaze) is never setup', () => {
  // Power-Up Punch is the textbook example but is not in the Gen 9 data; the hand-built battles are Gen 9.
  for (const [move, stat] of [['Flame Charge', 'spe'], ['Trailblaze', 'spe']]) {
    const hit = (foe, next) => [...ko(move, foe, next), `|-boost|p1a: Snorlax|${stat}|1`];
    const r = game([hit('Charizard', 'Moltres'), hit('Moltres', 'Gengar')], { moves: [move] });
    assert.deepStrictEqual(r.moments, [], move);
  }
});

test('setup-paid-off: Belly Drum counts (the data has no boosts for it; CONFIG.extraSetupMoves does)', () => {
  const drum = ['|move|p1a: Snorlax|Belly Drum|p1a: Snorlax', '|-damage|p1a: Snorlax|50/100', '|-setboost|p1a: Snorlax|atk|6|[from] move: Belly Drum'];
  const r = game([drum, ko('Body Slam', 'Charizard', 'Moltres'), ko('Body Slam', 'Moltres', 'Gengar')], { moves: ['Belly Drum', 'Body Slam'] });
  assert.deepStrictEqual(rules(r), [[3, 'setup-paid-off', 'good', 'Snorlax']]);
});

test('setup-paid-off: a setup used in an earlier stay does not carry over to the next Pokémon', () => {
  const swapIn = ['|switch|p1a: Venusaur|Venusaur, L80|100/100'];
  const r = game([swordsDance, swapIn, ko('Body Slam', 'Charizard', 'Moltres'), ko('Body Slam', 'Moltres', 'Gengar')]);
  assert.deepStrictEqual(r.moments.filter((m) => m.rule === 'setup-paid-off'), []);
});

test('setup-paid-off + 3 knockouts: only a ko-streak, with setUpFirst (one moment per achievement)', () => {
  const r = game([swordsDance, ko('Body Slam', 'Charizard', 'Moltres'), ko('Body Slam', 'Moltres', 'Gengar'), ko('Body Slam', 'Gengar', 'Blissey')]);
  assert.deepStrictEqual(rules(r), [[4, 'ko-streak', 'great', 'Snorlax']]);
  assert.strictEqual(r.moments[0].facts.setUpFirst, true);
  assert.strictEqual(r.moments[0].facts.count, 3);
});

// ---------------------------------------------------------------------------
// ko-streak at game end
// ---------------------------------------------------------------------------

test('ko-streak: two knockouts count when the last one won the game', () => {
  const r = game([ko('Body Slam', 'Charizard', 'Moltres'), ko('Body Slam', 'Moltres')], { end: ['|win|Alice'] });
  assert.deepStrictEqual(rules(r), [[2, 'ko-streak', 'great', 'Snorlax']]);
  assert.strictEqual(r.moments[0].facts.endedGame, true);
  assert.match(r.moments[0].facts.whyKnowable, /and its last knockout won the game$/);
});

test('ko-streak: two knockouts do NOT count when I did not win, or the game went on', () => {
  const two = [ko('Body Slam', 'Charizard', 'Moltres'), ko('Body Slam', 'Moltres', 'Gengar')];
  assert.deepStrictEqual(game(two).moments, []); // no |win| line: the game went on
  assert.deepStrictEqual(game(two, { end: ['|win|Bob'] }).moments, []); // I lost
});

test('ko-streak: does NOT count when the last opposing Pokémon fell to something other than my knockout', () => {
  // My 2nd knockout is followed by the opponent's last Pokémon fainting to poison, then I win.
  const poison = ['|-damage|p2a: Gengar|0 fnt|[from] psn', '|faint|p2a: Gengar'];
  const r = game([ko('Body Slam', 'Charizard', 'Moltres'), ko('Body Slam', 'Moltres', 'Gengar'), poison], { end: ['|win|Alice'] });
  assert.deepStrictEqual(r.moments, []);
});
