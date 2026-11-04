// Tests for the five rules added in docs/task-new-rules.md: good-tera, move-failed,
// bad-replacement, low-hp-switch-in, ko-streak. Each has one test on the real 35-turn log and
// "does NOT fire" cases built from small hand-written battles.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildBattle } = require('../src/core/state');
const { buildReview } = require('../src/core/review');

const BIG = 'battle-gen9randombattle-2707352165-ghpcomhxs9xljqkvhxs3ufwfmwhjj0qpw.log';
const bigReview = buildReview(
  buildBattle(fs.readFileSync(path.join(__dirname, '..', 'test-data', BIG), 'utf8').split(/\r?\n/)),
  { room: 'big' },
);
const bigMoment = (rule) => bigReview.moments.find((m) => m.rule === rule);

// ---------------------------------------------------------------------------
// A tiny battle builder. I am p1 (Alice). Each turn lists:
//   team:  [[name, condition], ...] my whole team (the first entry is the active Pokémon)
//   body:  protocol lines of the turn
//   force: optional { team, lines }: a forceSwitch request after the body (a faint or a pivot),
//          then the lines that follow it (the replacement's |switch|)
//   moves: optional move names for the active request
// ---------------------------------------------------------------------------
function request(kind, team, moves = ['Tackle']) {
  const side = {
    name: 'Alice', id: 'p1',
    // A team entry may carry a third value: my item id (as in a real |request|).
    pokemon: team.map(([name, condition, item], i) => ({ ident: `p1: ${name}`, details: `${name}, L80`, condition, active: i === 0, moves: ['tackle'], ...(item ? { item } : {}) })),
  };
  if (kind === 'force') return { forceSwitch: [true], side };
  return { active: [{ moves: moves.map((m) => ({ move: m, id: m.toLowerCase().replace(/[^a-z0-9]/g, ''), pp: 10, maxpp: 10 })) }], side };
}

function game({ mine, theirs, turns, config }) {
  const lines = [
    '|init|battle', '|gametype|singles', '|player|p1|Alice|1|1000', '|player|p2|Bob|2|1000',
    '|gen|9', '|tier|[Gen 9] Random Battle', '|start',
    `|switch|p1a: ${mine}|${mine}, L80|100/100`, `|switch|p2a: ${theirs}|${theirs}, L80|100/100`,
  ];
  turns.forEach((t, i) => {
    lines.push(`|turn|${i + 1}`, `|request|${JSON.stringify(request('active', t.team, t.moves))}`, ...t.body);
    if (t.force) lines.push(`|request|${JSON.stringify(request('force', t.force.team))}`, ...t.force.lines);
  });
  return buildReview(buildBattle(lines), { room: 'mini', config });
}

const rules = (r) => r.moments.map((m) => [m.turn, m.rule, m.label]);

// ---------------------------------------------------------------------------
// 4. good-tera
// ---------------------------------------------------------------------------

test('good-tera: Sceptile Terastallizing into Steel against Psychic Noise (35-turn log, turn 4)', () => {
  const m = bigMoment('good-tera');
  assert.deepStrictEqual([m.turn, m.label, m.mon], [4, 'good', 'Sceptile']);
  assert.deepStrictEqual(
    [m.facts.oldTypes, m.facts.teraType, m.facts.oppMon, m.facts.oppMove, m.facts.oldMultiplier, m.facts.newMultiplier],
    [['Grass'], 'Steel', 'Gothitelle', 'Psychic Noise', 1, 0.5],
  );
  assert.strictEqual(m.facts.knowable, true);
});

test('good-tera: turning a super-effective hit into a resisted one is "great"', () => {
  const team = [['Venusaur', '100/100'], ['Snorlax', '100/100']];
  const r = game({
    mine: 'Venusaur', theirs: 'Charizard',
    turns: [{ team, body: ['|-terastallize|p1a: Venusaur|Water', '|move|p2a: Charizard|Flamethrower|p1a: Venusaur', '|-resisted|p1a: Venusaur', '|-damage|p1a: Venusaur|90/100'] }],
  });
  assert.deepStrictEqual(rules(r), [[1, 'good-tera', 'great']]);
  assert.strictEqual(r.moments[0].facts.oldMultiplier, 2);
});

test('good-tera: does NOT fire when the opponent was faster (the hit came before the Tera)', () => {
  const team = [['Snorlax', '100/100'], ['Venusaur', '100/100']];
  const r = game({
    mine: 'Snorlax', theirs: 'Charizard',
    turns: [{ team, body: ['|move|p2a: Charizard|Flamethrower|p1a: Snorlax', '|-damage|p1a: Snorlax|80/100', '|-terastallize|p1a: Snorlax|Water', '|move|p1a: Snorlax|Tackle|p2a: Charizard'] }],
  });
  assert.deepStrictEqual(r.moments, []);
});

test('good-tera: does NOT fire when the new type does not resist, or the log shows no resistance', () => {
  const team = [['Snorlax', '100/100'], ['Venusaur', '100/100']];
  // Ghost takes a Fire move at 1x: the log says nothing about resistance.
  const r = game({
    mine: 'Snorlax', theirs: 'Charizard',
    turns: [{ team, body: ['|-terastallize|p1a: Snorlax|Ghost', '|move|p2a: Charizard|Flamethrower|p1a: Snorlax', '|-damage|p1a: Snorlax|80/100'] }],
  });
  assert.deepStrictEqual(r.moments, []);
  // A Stellar Tera is never judged.
  const s = game({
    mine: 'Snorlax', theirs: 'Charizard',
    turns: [{ team, body: ['|-terastallize|p1a: Snorlax|Stellar', '|move|p2a: Charizard|Flamethrower|p1a: Snorlax', '|-resisted|p1a: Snorlax', '|-damage|p1a: Snorlax|90/100'] }],
  });
  assert.deepStrictEqual(s.moments, []);
});

test('good-tera: does NOT fire when the hit missed, or its move was not knowable', () => {
  const team = [['Venusaur', '100/100'], ['Snorlax', '100/100']];
  const missed = game({
    mine: 'Venusaur', theirs: 'Charizard',
    turns: [{ team, body: ['|-terastallize|p1a: Venusaur|Water', '|move|p2a: Charizard|Flamethrower|p1a: Venusaur|[miss]', '|-miss|p2a: Charizard'] }],
  });
  assert.deepStrictEqual(missed.moments, []);
  // Surf is not a Fire/Flying move and has not been used before.
  const hidden = game({
    mine: 'Venusaur', theirs: 'Charizard',
    turns: [{ team, body: ['|-terastallize|p1a: Venusaur|Water', '|move|p2a: Charizard|Surf|p1a: Venusaur', '|-resisted|p1a: Venusaur', '|-damage|p1a: Venusaur|90/100'] }],
  });
  assert.deepStrictEqual(hidden.moments, []);
});

// ---------------------------------------------------------------------------
// bad-tera (the mirror of good-tera)
// ---------------------------------------------------------------------------

// Snorlax (Normal, takes Flamethrower at 1x) Terastallizes into `teraType`; Charizard's
// Flamethrower then hits for `damage` percent.
function teraHitGame({ mine = 'Snorlax', teraType, damage, body }) {
  const team = [[mine, '100/100'], ['Gengar', '100/100']];
  const hp = 100 - damage;
  return game({
    mine, theirs: 'Charizard',
    turns: [{ team, body: body || [`|-terastallize|p1a: ${mine}|${teraType}`, `|move|p2a: Charizard|Flamethrower|p1a: ${mine}`, '|-supereffective|p1a: ' + mine, `|-damage|p1a: ${mine}|${hp}/100`] }],
  });
}

test('bad-tera: Terastallizing into Grass and taking a 60% Flamethrower is a blunder', () => {
  const r = teraHitGame({ teraType: 'Grass', damage: 60 });
  assert.deepStrictEqual(rules(r), [[1, 'bad-tera', 'blunder']]);
  const f = r.moments[0].facts;
  assert.deepStrictEqual([f.oldTypes, f.teraType, f.oldMultiplier, f.newMultiplier, f.damagePct, f.knockedOut], [['Normal'], 'Grass', 1, 2, 60, false]);
  assert.strictEqual(f.knowable, true);
});

test('bad-tera: a 30% hit is a mistake, a 10% hit is not flagged', () => {
  assert.deepStrictEqual(rules(teraHitGame({ teraType: 'Grass', damage: 30 })), [[1, 'bad-tera', 'mistake']]);
  assert.deepStrictEqual(teraHitGame({ teraType: 'Grass', damage: 10 }).moments, []);
});

test('bad-tera: does NOT fire when the old types were already weak to the hit', () => {
  // Venusaur (Grass/Poison) is already 2x weak to Fire, so Terastallizing into Grass made nothing worse.
  const r = teraHitGame({ mine: 'Venusaur', teraType: 'Grass', damage: 60 });
  assert.deepStrictEqual(r.moments, []);
});

test('bad-tera: does NOT fire when the opponent was faster, or the hit was not super effective', () => {
  const faster = teraHitGame({
    teraType: 'Grass', damage: 60,
    body: ['|move|p2a: Charizard|Flamethrower|p1a: Snorlax', '|-supereffective|p1a: Snorlax', '|-damage|p1a: Snorlax|40/100', '|-terastallize|p1a: Snorlax|Grass'],
  });
  assert.deepStrictEqual(faster.moments, []);
  const neutral = teraHitGame({
    teraType: 'Grass', damage: 60,
    body: ['|-terastallize|p1a: Snorlax|Grass', '|move|p2a: Charizard|Flamethrower|p1a: Snorlax', '|-damage|p1a: Snorlax|40/100'],
  });
  assert.deepStrictEqual(neutral.moments, []);
});

test('bad-tera: does NOT fire when the hit missed, or its move was not knowable', () => {
  const missed = teraHitGame({
    teraType: 'Grass', damage: 60,
    body: ['|-terastallize|p1a: Snorlax|Grass', '|move|p2a: Charizard|Flamethrower|p1a: Snorlax|[miss]', '|-miss|p2a: Charizard'],
  });
  assert.deepStrictEqual(missed.moments, []);
  // Ice Beam is not Fire/Flying and was never used before, so it could not be foreseen.
  const hidden = teraHitGame({
    teraType: 'Steel', damage: 60,
    body: ['|-terastallize|p1a: Snorlax|Steel', '|move|p2a: Charizard|Ice Beam|p1a: Snorlax', '|-damage|p1a: Snorlax|40/100'],
  });
  assert.deepStrictEqual(hidden.moments, []);
});

// ---------------------------------------------------------------------------
// 3. move-failed
// ---------------------------------------------------------------------------

test('move-failed: Leech Seed into a Pokémon that is still seeded (35-turn log, turn 7)', () => {
  const m = bigMoment('move-failed');
  assert.deepStrictEqual([m.turn, m.label, m.mon], [7, 'mistake', 'Sceptile']);
  assert.deepStrictEqual(
    [m.facts.myMove, m.facts.oppMon, m.facts.reason, m.facts.since],
    ['Leech Seed', 'Gothitelle', 'already-active', 5],
  );
});

const SNORLAX_TEAM = [['Snorlax', '100/100'], ['Venusaur', '100/100']];

test('move-failed: a status move into an already-statused target (reason already-statused)', () => {
  const r = game({
    mine: 'Snorlax', theirs: 'Charizard',
    turns: [
      { team: SNORLAX_TEAM, body: ['|move|p1a: Snorlax|Will-O-Wisp|p2a: Charizard', '|-status|p2a: Charizard|brn'] },
      { team: SNORLAX_TEAM, body: ['|move|p1a: Snorlax|Thunder Wave||[still]', '|-fail|p1a: Snorlax'] },
    ],
  });
  assert.deepStrictEqual(rules(r), [[2, 'move-failed', 'mistake']]);
  assert.deepStrictEqual(
    [r.moments[0].facts.reason, r.moments[0].facts.since, r.moments[0].facts.oppMon],
    ['already-statused', 'brn', 'Charizard'],
  );
});

test('move-failed: does NOT fire for failures that depend on hidden information or luck', () => {
  // Sucker Punch fails when the target does not attack; Thunder Wave on an unstatused target is not "obviously" doomed.
  const r = game({
    mine: 'Snorlax', theirs: 'Charizard',
    turns: [
      { team: SNORLAX_TEAM, body: ['|move|p1a: Snorlax|Sucker Punch||[still]', '|-fail|p1a: Snorlax'] },
      { team: SNORLAX_TEAM, body: ['|move|p1a: Snorlax|Thunder Wave||[still]', '|-fail|p1a: Snorlax'] },
    ],
  });
  assert.deepStrictEqual(r.moments, []);
});

test('move-failed: does NOT fire when the target switched, or the effect had ended', () => {
  const seed = ['|move|p1a: Snorlax|Leech Seed|p2a: Charizard', '|-start|p2a: Charizard|move: Leech Seed'];
  const failed = ['|move|p1a: Snorlax|Leech Seed||[still]', '|-fail|p1a: Snorlax'];
  // The opponent switched in before my move: I chose against a different Pokémon.
  const switched = game({
    mine: 'Snorlax', theirs: 'Charizard',
    turns: [{ team: SNORLAX_TEAM, body: seed }, { team: SNORLAX_TEAM, body: ['|switch|p2a: Moltres|Moltres, L80|100/100', ...failed] }],
  });
  assert.deepStrictEqual(switched.moments, []);
  // The seed was cleared by a later "-end" line, so the failure has some other cause.
  const ended = game({
    mine: 'Snorlax', theirs: 'Charizard',
    turns: [{ team: SNORLAX_TEAM, body: [...seed, '|-end|p2a: Charizard|move: Leech Seed'] }, { team: SNORLAX_TEAM, body: failed }],
  });
  assert.deepStrictEqual(ended.moments, []);
  // The first use itself failed, so there is no earlier success to point at.
  const neverWorked = game({
    mine: 'Snorlax', theirs: 'Charizard',
    turns: [{ team: SNORLAX_TEAM, body: failed }, { team: SNORLAX_TEAM, body: failed }],
  });
  assert.deepStrictEqual(neverWorked.moments, []);
});

// ---------------------------------------------------------------------------
// 1. bad-replacement
// ---------------------------------------------------------------------------

// Turn 1 reveals Flamethrower. Turn 2: my Snorlax faints to it, then a replacement comes in
// and (turn 3) Charizard's Flamethrower hits it.
// `firstMove` is what Charizard uses on turns 1-2; anything but Flamethrower leaves it unrevealed.
function replacementGame({ replacement = 'Venusaur', bench, after = '40/100', entryHp = '100/100', extraTurn3 = [], attacker = 'Charizard', firstMove = 'Flamethrower' }) {
  const t1 = [['Snorlax', '100/100'], ...bench];
  const t2force = [['Snorlax', '0 fnt'], ...bench];
  return game({
    mine: 'Snorlax', theirs: 'Charizard',
    turns: [
      { team: t1, body: [`|move|p2a: Charizard|${firstMove}|p1a: Snorlax`, '|-damage|p1a: Snorlax|50/100'] },
      {
        team: t1,
        body: [`|move|p2a: Charizard|${firstMove}|p1a: Snorlax`, '|-damage|p1a: Snorlax|0 fnt', '|faint|p1a: Snorlax', '|upkeep'],
        force: { team: t2force, lines: [`|switch|p1a: ${replacement}|${replacement}, L80|${entryHp}`] },
      },
      {
        team: [[replacement, entryHp], ...bench.filter(([n]) => n !== replacement)],
        body: [...extraTurn3, `|move|p2a: ${attacker}|Flamethrower|p1a: ${replacement}`, `|-supereffective|p1a: ${replacement}`, `|-damage|p1a: ${replacement}|${after}`],
      },
    ],
  });
}

test('bad-replacement: Masquerain sent in against Rhyperior is a blunder (35-turn log, turn 12, hit on turn 13)', () => {
  const m = bigMoment('bad-replacement');
  assert.deepStrictEqual([m.turn, m.label, m.mon], [12, 'blunder', 'Masquerain']);
  assert.deepStrictEqual(
    [m.facts.replacedAfter, m.facts.oppMon, m.facts.oppMove, m.facts.multiplier, m.facts.knockedOut, m.facts.hitTurn],
    // Stone Edge had not been revealed when Masquerain came in, so only its type is named.
    ['faint', 'Rhyperior', null, 4, true, 13],
  );
  assert.strictEqual(m.facts.oppMoveType, 'Rock');
  assert.strictEqual(m.facts.whyKnowable, 'Rhyperior is a Rock type, so a Rock move was likely');
  // The safer option is a healthy one that takes at most a normal hit, never Masquerain itself.
  assert.ok(m.facts.saferOption.multiplier <= 1);
  assert.notStrictEqual(m.facts.saferOption.name, 'Masquerain');
});

test('bad-replacement: fires when a safe option was on the bench, and names it', () => {
  const r = replacementGame({ bench: [['Venusaur', '100/100'], ['Gengar', '100/100']] });
  assert.deepStrictEqual(rules(r), [[2, 'bad-replacement', 'blunder']]);
  const f = r.moments[0].facts;
  assert.deepStrictEqual([f.replacedAfter, f.hitTurn, f.damagePct, f.saferOption], ['faint', 3, 60, { name: 'Gengar', multiplier: 1 }]);
});

test('bad-replacement: does NOT fire when every option was weak to the move (fairness check)', () => {
  const r = replacementGame({ bench: [['Venusaur', '100/100'], ['Ivysaur', '100/100']] });
  assert.deepStrictEqual(r.moments, []);
});

test('bad-replacement: does NOT fire for a small hit, or when the opponent switched before hitting', () => {
  const bench = [['Venusaur', '100/100'], ['Gengar', '100/100']];
  assert.deepStrictEqual(replacementGame({ bench, after: '90/100' }).moments, []); // 10% is not worth flagging
  const sw = replacementGame({ bench, extraTurn3: ['|switch|p2a: Moltres|Moltres, L80|100/100'], attacker: 'Moltres' });
  assert.deepStrictEqual(sw.moments.filter((m) => m.rule === 'bad-replacement'), []);
});

test('bad-replacement: does NOT fire when the replacement holds Weakness Policy and survives (log 2707347511, turn 12)', () => {
  const gen = replacementGame({ bench: [['Venusaur', '100/100', 'weaknesspolicy'], ['Gengar', '100/100']] });
  assert.deepStrictEqual(gen.moments.filter((m) => m.rule === 'bad-replacement'), []);
  // Same game without the item is still flagged, so the test above cannot pass by accident.
  const noItem = replacementGame({ bench: [['Venusaur', '100/100', 'leftovers'], ['Gengar', '100/100']] });
  assert.deepStrictEqual(rules(noItem), [[2, 'bad-replacement', 'blunder']]);
  // If the hit knocks the holder out the policy never triggers, so it is still a blunder.
  const ko = replacementGame({ bench: [['Venusaur', '100/100', 'weaknesspolicy'], ['Gengar', '100/100']], after: '0 fnt' });
  assert.deepStrictEqual(rules(ko), [[2, 'bad-replacement', 'blunder']]);

  // The real log: Golem (Weakness Policy) took Freeze-Dry, then KO'd Delibird.
  const real = buildReview(
    buildBattle(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'battle-gen9randombattle-2707347511-gk6nrt15cpatbvcdr3bmvh51vg2fdi3pw.log'), 'utf8').split(/\r?\n/)),
    { room: 'golem' },
  );
  assert.deepStrictEqual(real.moments.filter((m) => m.rule === 'bad-replacement'), []);
});

test('bad-replacement: a move that was not revealed yet is described by its type only', () => {
  const bench = [['Venusaur', '100/100'], ['Gengar', '100/100']];
  const hidden = replacementGame({ bench, firstMove: 'Air Slash' });
  assert.deepStrictEqual(rules(hidden), [[2, 'bad-replacement', 'blunder']]);
  const f = hidden.moments[0].facts;
  assert.strictEqual(f.whyKnowable, 'Charizard is a Fire type, so a Fire move was likely');
  assert.strictEqual(f.oppMove, null); // the move name must not leak into the facts either
  assert.strictEqual(f.oppMoveType, 'Fire');
  // A revealed move keeps the old wording and the move name.
  const shown = replacementGame({ bench });
  assert.strictEqual(shown.moments[0].facts.whyKnowable, 'Charizard is a Fire type and had already used Flamethrower on turn 1');
  assert.strictEqual(shown.moments[0].facts.oppMove, 'Flamethrower');

  // The real log (2707578345): Kyurem sent in against Flamigo, whose Close Combat was not revealed.
  const real = buildReview(
    buildBattle(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'battle-gen9randombattle-2707578345.log'), 'utf8').split(/\r?\n/)),
    { room: 'flamigo' },
  );
  const m = real.moments.find((x) => x.rule === 'bad-replacement' && x.mon === 'Kyurem');
  assert.strictEqual(m.facts.whyKnowable, 'Flamigo is a Fighting type, so a Fighting move was likely');
  assert.strictEqual(m.facts.oppMove, null);
});

// ---------------------------------------------------------------------------
// 2. low-hp-switch-in
// ---------------------------------------------------------------------------

// Like replacementGame but the replacement (Gengar, neutral to Fire) comes in at low HP and is
// knocked out by turn 3's Flamethrower before it acts.
function lowHpGame({ bench, gengarMoves = false }) {
  const t1 = [['Snorlax', '100/100'], ...bench];
  return game({
    mine: 'Snorlax', theirs: 'Charizard',
    turns: [
      { team: t1, body: ['|move|p2a: Charizard|Flamethrower|p1a: Snorlax', '|-damage|p1a: Snorlax|50/100'] },
      {
        team: t1,
        body: ['|move|p2a: Charizard|Flamethrower|p1a: Snorlax', '|-damage|p1a: Snorlax|0 fnt', '|faint|p1a: Snorlax', '|upkeep'],
        force: { team: [['Snorlax', '0 fnt'], ...bench], lines: ['|switch|p1a: Gengar|Gengar, L80|20/100'] },
      },
      {
        team: [['Gengar', '20/100'], ...bench.filter(([n]) => n !== 'Gengar')],
        body: [
          ...(gengarMoves ? ['|move|p1a: Gengar|Shadow Ball|p2a: Charizard', '|-damage|p2a: Charizard|60/100'] : []),
          '|move|p2a: Charizard|Flamethrower|p1a: Gengar', '|-damage|p1a: Gengar|0 fnt', '|faint|p1a: Gengar',
        ],
      },
    ],
  });
}

test('low-hp-switch-in: Sceptile brought in at 25% HP and knocked out before moving (35-turn log, turn 18)', () => {
  const m = bigMoment('low-hp-switch-in');
  assert.deepStrictEqual([m.turn, m.label, m.mon], [18, 'mistake', 'Sceptile']);
  assert.deepStrictEqual(
    [m.facts.hpWhenEntered, m.facts.faintedTurn, m.facts.koBy, m.facts.healthierOption.hpPct],
    [24.6, 19, { oppMon: 'Wo-Chien', move: 'Knock Off' }, 100],
  );
});

test('low-hp-switch-in: fires with a healthy option on the bench', () => {
  const r = lowHpGame({ bench: [['Gengar', '20/100'], ['Blissey', '100/100']] });
  assert.deepStrictEqual(rules(r), [[2, 'low-hp-switch-in', 'mistake']]);
  assert.deepStrictEqual(r.moments[0].facts.healthierOption, { name: 'Blissey', hpPct: 100 });
});

test('low-hp-switch-in: does NOT fire without a healthy alternative, or if the Pokémon moved first', () => {
  const noHealthy = lowHpGame({ bench: [['Gengar', '20/100'], ['Blissey', '30/100']] });
  assert.deepStrictEqual(noHealthy.moments, []);
  const moved = lowHpGame({ bench: [['Gengar', '20/100'], ['Blissey', '100/100']], gengarMoves: true });
  assert.deepStrictEqual(moved.moments, []);
});

test('low-hp-switch-in: bad-replacement already covering the same switch-in wins (one moment per mistake)', () => {
  // Venusaur comes in at 20% HP, weak to Flamethrower, with healthy safe options available.
  const r = replacementGame({ bench: [['Venusaur', '20/100'], ['Gengar', '100/100']], entryHp: '20/100', after: '0 fnt' });
  assert.deepStrictEqual(rules(r), [[2, 'bad-replacement', 'blunder']]);
});

// ---------------------------------------------------------------------------
// 5. ko-streak
// ---------------------------------------------------------------------------

// Snorlax (Body Slam, with Tackle as the weaker option) knocks out `n` opponents in a row.
function streakGame(n, config) {
  const foes = ['Charizard', 'Moltres', 'Gengar', 'Blissey'];
  const team = [['Snorlax', '100/100'], ['Venusaur', '100/100']];
  const turns = [];
  for (let i = 0; i < n; i++) {
    turns.push({
      team, moves: ['Body Slam', 'Tackle'],
      body: [
        `|move|p1a: Snorlax|Body Slam|p2a: ${foes[i]}`, `|-damage|p2a: ${foes[i]}|0 fnt`, `|faint|p2a: ${foes[i]}`, '|upkeep',
        `|switch|p2a: ${foes[i + 1]}|${foes[i + 1]}, L80|100/100`,
      ],
    });
  }
  return game({ mine: 'Snorlax', theirs: 'Charizard', turns, config });
}

test('ko-streak: Grumpig knocks out three Pokémon in one stay (35-turn log, placed on turn 27)', () => {
  const m = bigMoment('ko-streak');
  assert.deepStrictEqual([m.turn, m.label, m.mon, m.title], [27, 'great', 'Grumpig', 'Knockout streak']);
  assert.strictEqual(m.facts.count, 3);
  assert.deepStrictEqual(m.facts.kos.map((k) => [k.turn, k.oppMon, k.move]), [
    [25, 'Magnezone', 'Earth Power'], [26, 'Gothitelle', 'Earth Power'], [27, 'Cinderace', 'Earth Power'],
  ]);
});

test('ko-streak: three knockouts make one moment, and it replaces the found-the-ko moments inside it', () => {
  // Without the streak (threshold raised) turns 2 and 3 each have a found-the-ko moment (turn 1
  // cannot be judged: my first request arrives after the turn started). That proves the filter is real.
  assert.deepStrictEqual(rules(streakGame(3, { koStreakMin: 99 })), [[2, 'found-the-ko', 'good'], [3, 'found-the-ko', 'good']]);
  const r = streakGame(3);
  assert.deepStrictEqual(rules(r), [[3, 'ko-streak', 'great']]);
});

test('ko-streak: does NOT fire for only two knockouts (found-the-ko stays)', () => {
  const r = streakGame(2);
  assert.deepStrictEqual(rules(r), [[2, 'found-the-ko', 'good']]);
});
