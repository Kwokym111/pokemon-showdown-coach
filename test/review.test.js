// Tests for review.js. Part 1 runs every real log in test-data/ and checks the review's shape.
// Part 2 uses hand-made mini-logs, because the real logs contain only ONE qualifying moment
// (the Ceruledge switch) and none of the cases where a rule must stay quiet.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildBattle } = require('../src/core/state');
const { buildReview, CONFIG } = require('../src/core/review');

const DIR = path.join(__dirname, '..', 'test-data');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.log'));
const readLines = (f) => fs.readFileSync(path.join(DIR, f), 'utf8').split('\n');
const reviewOf = (f) => buildReview(buildBattle(readLines(f)), { room: f.replace(/\.log$/, '') });

const LABELS = ['great', 'good', 'mistake', 'blunder'];

// The facts keys the AI prompt is written against: handoff/sample-review.json, in that order.
const SAMPLE_KEYS = {
  'move-into-immunity': ['myMon', 'myMove', 'myMoveType', 'oppMon', 'oppTypes', 'multiplier', 'effectiveness', 'damagePct', 'knowable', 'whyKnowable'],
  'switched-into-immunity': ['myMon', 'myTypes', 'switchedOut', 'oppMon', 'oppTypes', 'oppMove', 'oppMoveType', 'multiplier', 'effectiveness', 'damagePct', 'knowable', 'whyKnowable'],
  'switched-into-super-effective': ['myMon', 'myTypes', 'switchedOut', 'oppMon', 'oppTypes', 'oppMove', 'oppMoveType', 'multiplier', 'damagePct', 'hpBefore', 'hpAfter', 'knockedOut', 'knowable', 'whyKnowable'],
  'missed-ko': ['myMon', 'myMove', 'myMoveMinPct', 'myMoveMaxPct', 'betterMove', 'betterMoveMinPct', 'betterMoveMaxPct', 'oppMon', 'oppTypes', 'oppHpPct', 'oppAbilityKnown', 'knowable', 'whyKnowable'],
  'weak-move-choice': ['myMon', 'myMove', 'myMoveMinPct', 'myMoveMaxPct', 'betterMove', 'betterMoveMinPct', 'betterMoveMaxPct', 'oppMon', 'oppTypes', 'oppHpPct', 'oppAbilityKnown', 'knowable', 'whyKnowable'],
  'found-the-ko': ['myMon', 'myMove', 'myMoveMinPct', 'myMoveMaxPct', 'bestOtherMove', 'bestOtherMaxPct', 'oppMon', 'oppTypes', 'oppHpPct', 'knowable', 'whyKnowable'],
  // Added by docs/task-new-rules.md (no handoff/sample-review.json entry yet; these keys are the contract).
  'good-tera': ['myMon', 'oldTypes', 'teraType', 'oppMon', 'oppMove', 'oppMoveType', 'oldMultiplier', 'newMultiplier', 'damagePct', 'knowable', 'whyKnowable'],
  'bad-tera': ['myMon', 'oldTypes', 'teraType', 'oppMon', 'oppMove', 'oppMoveType', 'oldMultiplier', 'newMultiplier', 'damagePct', 'knockedOut', 'knowable', 'whyKnowable'],
  'move-failed': ['myMon', 'myMove', 'oppMon', 'reason', 'since', 'knowable', 'whyKnowable'],
  'bad-replacement': ['myMon', 'myTypes', 'replacedAfter', 'oppMon', 'oppTypes', 'oppMove', 'oppMoveType', 'multiplier', 'damagePct', 'hpBefore', 'hpAfter', 'knockedOut', 'hitTurn', 'saferOption', 'knowable', 'whyKnowable'],
  'low-hp-switch-in': ['myMon', 'hpWhenEntered', 'faintedTurn', 'koBy', 'healthierOption', 'knowable', 'whyKnowable'],
  'ko-streak': ['myMon', 'count', 'kos', 'endedByForfeit', 'endedGame', 'setUpFirst', 'setupMoves', 'knowable', 'whyKnowable'],
  // Added by docs/task-good-moment-rules.md.
  'setup-paid-off': ['myMon', 'setupMoves', 'kos', 'knowable', 'whyKnowable'],
  // Added by docs/task-risky-switch-forfeit-streak.md.
  'risky-switch': ['myMon', 'myTypes', 'switchedOut', 'oppMon', 'oppTypes', 'oppMove', 'oppMoveType', 'multiplier', 'revealedTurn', 'whatHappened', 'saferOption', 'knowable', 'whyKnowable'],
};

function assertShape(review) {
  assert.strictEqual(review.version, 1);
  assert.strictEqual(review.aiUsed, false);
  assert.strictEqual(review.summary, null);
  assert.deepStrictEqual(Object.keys(review), ['version', 'room', 'players', 'result', 'aiUsed', 'summary', 'moments']);
  assert.ok(Array.isArray(review.moments));
  let last = 0;
  for (const m of review.moments) {
    assert.ok(LABELS.includes(m.label), `bad label ${m.label}`);
    assert.strictEqual(m.explanation, null);
    assert.ok(m.rule in SAMPLE_KEYS, `unknown rule ${m.rule}`);
    assert.deepStrictEqual(Object.keys(m), ['turn', 'rule', 'label', 'mon', 'title', 'explanation', 'facts']);
    assert.deepStrictEqual(Object.keys(m.facts), SAMPLE_KEYS[m.rule], `${m.rule} facts drifted from the sample`);
    assert.strictEqual(m.facts.knowable, true);
    assert.ok(m.turn >= last, 'moments out of turn order');
    last = m.turn;
  }
  assert.deepStrictEqual(JSON.parse(JSON.stringify(review)), review); // plain JSON data only
}

// ---------------------------------------------------------------------------
// Part 1: real logs
// ---------------------------------------------------------------------------

test('the sample review in handoff/ still agrees with SAMPLE_KEYS', (t) => {
  const p = path.join(__dirname, '..', 'handoff', 'sample-review.json');
  if (!fs.existsSync(p)) return t.skip('handoff/sample-review.json not present');
  for (const m of JSON.parse(fs.readFileSync(p, 'utf8')).moments) {
    assert.deepStrictEqual(Object.keys(m.facts), SAMPLE_KEYS[m.rule], m.rule);
  }
});

for (const f of files) {
  test(`real log ${f}: review has the agreed shape and is repeatable`, () => {
    const b = buildBattle(readLines(f));
    const review = buildReview(b, { room: 'r' });
    assertShape(review);
    assert.strictEqual(review.players.me, 'cool213');
    assert.deepStrictEqual(buildReview(b, { room: 'r' }), review); // pure: same input, same output
    // Nothing is judged on a turn that has no decision to judge.
    assert.ok(review.moments.every((m) => m.turn >= 1));
  });
}

test('real log: Close Combat into a same-turn Tera Ghost is not flagged (turn 1)', () => {
  const review = reviewOf('battle-gen9randombattle-2707357132.log');
  assert.ok(!review.moments.some((m) => m.turn === 1));
  assert.ok(!review.moments.some((m) => m.rule === 'move-into-immunity'));
});

test('real log: Carbink -> Ceruledge into Body Slam is one "great" switch (turn 10)', () => {
  const review = reviewOf('battle-gen9randombattle-2707357132.log');
  assert.strictEqual(review.moments.length, 1);
  const m = review.moments[0];
  assert.deepStrictEqual([m.turn, m.rule, m.label, m.mon], [10, 'switched-into-immunity', 'great', 'Ceruledge']);
  assert.deepStrictEqual(m.facts, {
    myMon: 'Ceruledge', myTypes: ['Fire', 'Ghost'], switchedOut: 'Carbink',
    oppMon: 'Vigoroth', oppTypes: ['Ghost'], oppMove: 'Body Slam', oppMoveType: 'Normal',
    multiplier: 0, effectiveness: 'immune', damagePct: 0, knowable: true,
    whyKnowable: 'Vigoroth had already used Body Slam on turn 4',
  });
  assert.deepStrictEqual(review.result, { won: false, forfeit: true, lastTurn: 15 });
});

test('real log: a 5-turn forfeit with no faints flags no mistakes', () => {
  const review = reviewOf('battle-gen9randombattle-2707569201.log');
  assert.ok(!review.moments.some((m) => m.label === 'mistake' || m.label === 'blunder'));
});

// ---------------------------------------------------------------------------
// Part 2: mini-logs
// ---------------------------------------------------------------------------

// A tiny battle. `me` is learned from a |request| (as in the real app), which we send after
// every |turn| listing my whole team, so my benched Pokémon have a species the review can find.
// Pokémon are named after their species, so "p1a: Snorlax" is a Snorlax.
function mini({ me = 'p1', gen = 9, p1 = ['Snorlax', 'Venusaur', 'Gengar'], p2 = ['Charizard', 'Moltres'], turns, win }) {
  const mine = me === 'p1' ? p1 : p2;
  const side = me;
  const request = {
    side: {
      name: me === 'p1' ? 'Alice' : 'Bob', id: side,
      pokemon: mine.map((n) => ({ ident: `${side}: ${n}`, details: `${n}, L80`, condition: '100/100', active: false, moves: ['tackle'] })),
    },
    active: [{ moves: [{ move: 'Tackle', id: 'tackle', pp: 35, maxpp: 35 }] }],
  };
  const lines = [
    '|init|battle', '|gametype|singles', '|player|p1|Alice|1|1000', '|player|p2|Bob|2|1000',
    `|gen|${gen}`, `|tier|[Gen ${gen}] Random Battle`, '|start',
    `|switch|p1a: ${p1[0]}|${p1[0]}, L80|100/100`, `|switch|p2a: ${p2[0]}|${p2[0]}, L80|100/100`,
  ];
  turns.forEach((body, i) => lines.push(`|turn|${i + 1}`, `|request|${JSON.stringify(request)}`, ...body));
  if (win) lines.push(`|win|${win}`);
  return buildReview(buildBattle(lines), { room: 'mini' });
}

const NOTHING = ['|move|p2a: Charizard|Flamethrower|p1a: Snorlax', '|-damage|p1a: Snorlax|90/100']; // reveals Flamethrower

describe_move_into_immunity();
describe_switch_rules();

function describe_move_into_immunity() {
  // p1 Snorlax (Normal) vs p2 Gengar (Ghost/Poison).
  const P2 = ['Gengar', 'Blissey'];
  const bodySlamImmune = ['|move|p1a: Snorlax|Body Slam|p2a: Gengar', '|-immune|p2a: Gengar'];

  test('move-into-immunity: a Normal move into a Ghost already in play is a mistake', () => {
    const r = mini({ p2: P2, turns: [['|move|p1a: Snorlax|Tackle|p2a: Gengar', '|-immune|p2a: Gengar'], ['|move|p1a: Snorlax|Body Slam|p2a: Gengar', '|-immune|p2a: Gengar']] });
    assertShape(r);
    assert.strictEqual(r.moments.length, 2); // Tackle on turn 1 and Body Slam on turn 2 are both wasted turns
    const m = r.moments[1];
    assert.deepStrictEqual([m.turn, m.rule, m.label, m.mon, m.title], [2, 'move-into-immunity', 'mistake', 'Snorlax', 'Used a move the target is immune to']);
    assert.deepStrictEqual(m.facts, {
      myMon: 'Snorlax', myMove: 'Body Slam', myMoveType: 'Normal', oppMon: 'Gengar', oppTypes: ['Ghost', 'Poison'],
      multiplier: 0, effectiveness: 'immune', damagePct: 0, knowable: true,
      whyKnowable: 'Gengar had been in play since the start of the battle and had not Terastallized',
    });
  });

  test('move-into-immunity: works when the player is p2', () => {
    const r = mini({ me: 'p2', p1: ['Gengar', 'Blissey'], p2: ['Snorlax', 'Venusaur'], turns: [['|move|p2a: Snorlax|Body Slam|p1a: Gengar', '|-immune|p1a: Gengar']] });
    assert.strictEqual(r.players.me, 'Bob');
    assert.deepStrictEqual(r.moments.map((m) => [m.turn, m.rule]), [[1, 'move-into-immunity']]);
  });

  test('move-into-immunity: the opponent switching in this turn is not held against the player', () => {
    const r = mini({ p2: ['Blissey', 'Gengar'], turns: [['|switch|p2a: Gengar|Gengar, L80|100/100', ...bodySlamImmune]] });
    assert.deepStrictEqual(r.moments, []);
  });

  test('move-into-immunity: a Tera on this very turn is not held against the player', () => {
    // Blissey is Normal at the start of the turn, so Body Slam was a fair choice.
    const r = mini({ p2: ['Blissey', 'Gengar'], turns: [['|-terastallize|p2a: Blissey|Ghost', '|move|p1a: Snorlax|Body Slam|p2a: Blissey', '|-immune|p2a: Blissey']] });
    assert.deepStrictEqual(r.moments, []);
  });

  test('move-into-immunity: a Tera on an EARLIER turn is visible, and the wording says so', () => {
    const r = mini({ p2: ['Blissey', 'Gengar'], turns: [
      ['|-terastallize|p2a: Blissey|Ghost', '|move|p2a: Blissey|Soft-Boiled|p2a: Blissey'],
      ['|move|p1a: Snorlax|Body Slam|p2a: Blissey', '|-immune|p2a: Blissey'],
    ] });
    assert.strictEqual(r.moments.length, 1);
    assert.strictEqual(r.moments[0].facts.whyKnowable, 'Blissey had Terastallized into Ghost on turn 1');
    assert.deepStrictEqual(r.moments[0].facts.oppTypes, ['Ghost']);
  });

  test('move-into-immunity: moves called by another move, and situational-type moves, are skipped', () => {
    const called = mini({ p2: P2, turns: [['|move|p1a: Snorlax|Body Slam|p2a: Gengar|[from]Sleep Talk', '|-immune|p2a: Gengar']] });
    assert.deepStrictEqual(called.moments, []);
    const teraBlast = mini({ p2: P2, turns: [['|move|p1a: Snorlax|Tera Blast|p2a: Gengar', '|-immune|p2a: Gengar']] });
    assert.deepStrictEqual(teraBlast.moments, []);
  });

  test('move-into-immunity: the data and the log must agree', () => {
    // The log says "immune" but Tackle does hit a Fire type, so something else is going on (an
    // ability, say). With immuneBy set the review stays quiet.
    const r = mini({ p2: ['Charizard', 'Moltres'], turns: [['|move|p1a: Snorlax|Tackle|p2a: Charizard', '|-immune|p2a: Charizard|[from] ability: Wonder Guard']] });
    assert.deepStrictEqual(r.moments, []);
    const r2 = mini({ p2: ['Charizard', 'Moltres'], turns: [['|move|p1a: Snorlax|Tackle|p2a: Charizard', '|-immune|p2a: Charizard']] });
    assert.deepStrictEqual(r2.moments, []);
    // Even where the types also say 0, an immunity the log pins on an ability is not judged.
    const r3 = mini({ p2: P2, turns: [['|move|p1a: Snorlax|Body Slam|p2a: Gengar', '|-immune|p2a: Gengar|[from] ability: Levitate']] });
    assert.deepStrictEqual(r3.moments, []);
  });

  test('move-into-immunity: the generation is respected (Dragon into Fairy is immune from Gen 6 only)', () => {
    const lines = (gen) => mini({ gen, p1: ['Dragonite', 'Venusaur'], p2: ['Clefairy', 'Moltres'], turns: [['|move|p1a: Dragonite|Outrage|p2a: Clefairy', '|-immune|p2a: Clefairy']] });
    assert.strictEqual(lines(9).moments.length, 1);
    assert.deepStrictEqual(lines(5).moments, []); // Clefairy is Normal in Gen 5
  });
}

function describe_switch_rules() {
  // Turn 1 reveals Charizard's Flamethrower. Turn 2: Snorlax switches to Venusaur (Grass/Poison).
  const flame = (hpAfter, extra = []) => [
    '|switch|p1a: Venusaur|Venusaur, L80|100/100',
    '|move|p2a: Charizard|Flamethrower|p1a: Venusaur', '|-supereffective|p1a: Venusaur', `|-damage|p1a: Venusaur|${hpAfter}`, ...extra,
  ];
  const withFlame = (turn2, opts = {}) => mini({ ...opts, turns: [NOTHING, turn2] });

  test('switched-into-super-effective: 60% is a blunder, with sample-shaped facts', () => {
    const r = withFlame(flame('40/100'));
    assertShape(r);
    assert.strictEqual(r.moments.length, 1);
    const m = r.moments[0];
    assert.deepStrictEqual([m.turn, m.rule, m.label, m.mon, m.title], [2, 'switched-into-super-effective', 'blunder', 'Venusaur', 'Switched into a super-effective hit']);
    assert.deepStrictEqual(m.facts, {
      myMon: 'Venusaur', myTypes: ['Grass', 'Poison'], switchedOut: 'Snorlax',
      oppMon: 'Charizard', oppTypes: ['Fire', 'Flying'], oppMove: 'Flamethrower', oppMoveType: 'Fire',
      multiplier: 2, damagePct: 60, hpBefore: 100, hpAfter: 40, knockedOut: false, knowable: true,
      whyKnowable: 'Charizard is a Fire type and had already used Flamethrower on turn 1',
    });
  });

  test('switched-into-super-effective: a knock-out is a blunder, even when the Pokémon was only on the bench list', () => {
    // After the KO the replacement (Snorlax) is the active Pokémon, so Venusaur's species has to
    // come from the request's bench list.
    const r = withFlame(flame('0 fnt', ['|faint|p1a: Venusaur', '|switch|p1a: Snorlax|Snorlax, L80|100/100']));
    assert.deepStrictEqual(r.moments.map((m) => [m.rule, m.label, m.facts.knockedOut, m.facts.damagePct]), [['switched-into-super-effective', 'blunder', true, 100]]);
  });

  test('switched-into-super-effective: 30% is a mistake, 10% is not flagged', () => {
    assert.deepStrictEqual(withFlame(flame('70/100')).moments.map((m) => m.label), ['mistake']);
    assert.deepStrictEqual(withFlame(flame('90/100')).moments, []);
  });

  test('thresholds come from CONFIG and can be overridden per call', () => {
    assert.strictEqual(CONFIG.blunderDamagePct, 50);
    assert.strictEqual(CONFIG.mistakeDamagePct, 25);
    // mini() has no config option, so build the battle by hand and review it twice.
    const lines = [
      '|init|battle', '|gametype|singles', '|player|p1|Alice|1|1000', '|player|p2|Bob|2|1000', '|gen|9', '|tier|[Gen 9] Random Battle', '|start',
      '|switch|p1a: Snorlax|Snorlax, L80|100/100', '|switch|p2a: Charizard|Charizard, L80|100/100',
      '|turn|1', ...NOTHING, '|turn|2',
      `|request|${JSON.stringify({ side: { name: 'Alice', id: 'p1', pokemon: [{ ident: 'p1: Venusaur', details: 'Venusaur, L80', condition: '100/100', active: false }] }, active: [{ moves: [] }] })}`,
      ...flame('90/100'),
    ];
    const b = buildBattle(lines);
    assert.deepStrictEqual(buildReview(b).moments, []);
    assert.deepStrictEqual(buildReview(b, { config: { mistakeDamagePct: 5 } }).moments.map((m) => m.label), ['mistake']);
    assert.strictEqual(CONFIG.mistakeDamagePct, 25); // the override did not change the shared config
  });

  test('switched-into-super-effective: only a CHOSEN switch counts, not a post-faint replacement or a pivot', () => {
    // Replacement after a faint: the hit on Venusaur happens in the same turn, but Venusaur was not chosen into it.
    const replacement = withFlame([
      '|move|p1a: Snorlax|Tackle|p2a: Charizard', '|-damage|p2a: Charizard|50/100',
      '|move|p2a: Charizard|Flamethrower|p1a: Snorlax', '|-damage|p1a: Snorlax|0 fnt', '|faint|p1a: Snorlax',
      ...flame('40/100'),
    ]);
    assert.deepStrictEqual(replacement.moments, []);
    // Pivot, with and without the [from] tag: a move ran first, so it was not a switch at the start of the turn.
    for (const tag of ['|[from] U-turn', '']) {
      const pivot = withFlame([
        '|move|p1a: Snorlax|U-turn|p2a: Charizard', '|-damage|p2a: Charizard|60/100',
        `|switch|p1a: Venusaur|Venusaur, L80|100/100${tag}`,
        '|move|p2a: Charizard|Flamethrower|p1a: Venusaur', '|-supereffective|p1a: Venusaur', '|-damage|p1a: Venusaur|40/100',
      ]);
      assert.deepStrictEqual(pivot.moments, [], `pivot ${tag}`);
    }
  });

  test('switched-into-super-effective: not flagged when the player could not have known', () => {
    // Psychic is not a Flying/Fire move and Charizard had not used it before.
    const unknowable = withFlame([
      '|switch|p1a: Venusaur|Venusaur, L80|100/100',
      '|move|p2a: Charizard|Psychic|p1a: Venusaur', '|-supereffective|p1a: Venusaur', '|-damage|p1a: Venusaur|40/100',
    ]);
    assert.deepStrictEqual(unknowable.moments, []);
    // The opponent switched to Moltres this turn: the player chose against Charizard.
    const oppSwitch = withFlame([
      '|switch|p1a: Venusaur|Venusaur, L80|100/100', '|switch|p2a: Moltres|Moltres, L80|100/100',
      '|move|p2a: Moltres|Flamethrower|p1a: Venusaur', '|-supereffective|p1a: Venusaur', '|-damage|p1a: Venusaur|40/100',
    ]);
    assert.deepStrictEqual(oppSwitch.moments, []);
    // A miss is not a hit, so switched-into-super-effective says nothing. Since docs/task-risky-switch-forfeit-streak.md
    // the same turn is judged by risky-switch instead (Flamethrower was already revealed, a miss is luck).
    const miss = withFlame(['|switch|p1a: Venusaur|Venusaur, L80|100/100', '|move|p2a: Charizard|Flamethrower|p1a: Venusaur|[miss]', '|-miss|p2a: Charizard|p1a: Venusaur']);
    assert.deepStrictEqual(miss.moments.map((m) => m.rule), ['risky-switch']);
  });

  test('switched-into-super-effective: a hit that matches the opponent\'s own type counts as knowable even if unused', () => {
    const r = mini({ turns: [['|move|p2a: Charizard|Tackle|p1a: Snorlax', '|-damage|p1a: Snorlax|95/100'], flame('40/100')] });
    assert.strictEqual(r.moments[0].facts.whyKnowable, 'Charizard is a Fire type and Flamethrower is a Fire move');
  });

  test('switched-into-immunity: great, whether the move was revealed or just matches the type', () => {
    // Gengar is immune to Normal. Blissey (Normal) has used Body Slam on turn 1, or only Tackle.
    const slam = (mv) => mini({ p1: ['Snorlax', 'Gengar'], p2: ['Blissey', 'Moltres'], turns: [
      [`|move|p2a: Blissey|${mv}|p1a: Snorlax`, '|-damage|p1a: Snorlax|90/100'],
      ['|switch|p1a: Gengar|Gengar, L80|100/100', '|move|p2a: Blissey|Body Slam|p1a: Gengar', '|-immune|p1a: Gengar'],
    ] });
    const revealed = slam('Body Slam');
    assertShape(revealed);
    assert.deepStrictEqual(revealed.moments.map((m) => [m.rule, m.label, m.mon]), [['switched-into-immunity', 'great', 'Gengar']]);
    assert.strictEqual(revealed.moments[0].facts.whyKnowable, 'Blissey is a Normal type and had already used Body Slam on turn 1');
    const typeOnly = slam('Tackle');
    assert.strictEqual(typeOnly.moments[0].facts.whyKnowable, 'Blissey is a Normal type and Body Slam is a Normal move');
  });

  test('a spectated log (no |request|) and a log with no generation produce no moments', () => {
    const spectated = buildBattle([
      '|init|battle', '|gametype|singles', '|player|p1|Alice|1|1000', '|player|p2|Bob|2|1000', '|gen|9', '|tier|[Gen 9] Random Battle', '|start',
      '|switch|p1a: Snorlax|Snorlax, L80|100/100', '|switch|p2a: Gengar|Gengar, L80|100/100',
      '|turn|1', '|move|p1a: Snorlax|Body Slam|p2a: Gengar', '|-immune|p2a: Gengar', '|win|Alice',
    ]);
    const r = buildReview(spectated, { room: 'x' });
    assert.deepStrictEqual(r, { version: 1, room: 'x', players: { me: null, opponent: null }, result: { won: null, forfeit: false, lastTurn: 1 }, aiUsed: false, summary: null, moments: [] });
    const noGen = { ...spectated, me: 'p1', gen: null };
    assert.deepStrictEqual(buildReview(noGen).moments, []);
  });

  test('result.won: true for a win, false for a loss, null when unfinished; room defaults to null', () => {
    const t = [['|move|p1a: Snorlax|Tackle|p2a: Charizard', '|-damage|p2a: Charizard|90/100']];
    assert.strictEqual(mini({ turns: t, win: 'Alice' }).result.won, true);
    assert.strictEqual(mini({ turns: t, win: 'Bob' }).result.won, false);
    assert.strictEqual(mini({ turns: t }).result.won, null);
    assert.strictEqual(buildReview(buildBattle(['|init|battle'])).room, null);
  });
}
