// Tests for docs/task-risky-switch-forfeit-streak.md: the risky-switch rule and ko-streak
// counting a streak that ended with the opponent forfeiting. The real log is the 2709149901 game
// (opponent anonymised); the "does NOT fire" cases are small hand-written battles.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildBattle } = require('../src/core/state');
const { buildReview } = require('../src/core/review');

const LOG = 'battle-gen9randombattle-2709149901.log';
const real = buildReview(
  buildBattle(fs.readFileSync(path.join(__dirname, '..', 'test-data', LOG), 'utf8').split(/\r?\n/)),
  { room: 'real' },
);

// ---------------------------------------------------------------------------
// The real game
// ---------------------------------------------------------------------------

test('real game: exactly three moments (T7 found-the-ko, T11 risky-switch, T21 ko-streak)', () => {
  assert.deepStrictEqual(
    real.moments.map((m) => [m.turn, m.rule, m.label, m.mon]),
    [[7, 'found-the-ko', 'good', 'Glalie'], [11, 'risky-switch', 'mistake', 'Drifblim'], [21, 'ko-streak', 'great', 'Darkrai']],
  );
});

test('real game T11: Drifblim switched into Pachirisu, which had shown Discharge on turn 4', () => {
  const f = real.moments.find((m) => m.rule === 'risky-switch').facts;
  assert.deepStrictEqual(
    [f.myMon, f.myTypes, f.switchedOut, f.oppMon, f.oppMove, f.oppMoveType, f.multiplier, f.revealedTurn],
    ['Drifblim', ['Ghost', 'Flying'], 'Talonflame', 'Pachirisu', 'Discharge', 'Electric', 2, 4],
  );
  assert.strictEqual(f.whatHappened, 'Pachirisu used Encore instead, which failed, so the hit did not come this time');
  assert.ok(['Sableye', 'Darkrai'].includes(f.saferOption.name), f.saferOption.name);
  assert.deepStrictEqual([f.saferOption.multiplier, f.saferOption.hpPct], [1, 100]);
  assert.strictEqual(f.knowable, true);
  assert.match(f.whyKnowable, /Pachirisu had already used Discharge on turn 4/);
});

test('real game T21: Darkrai\'s two knockouts count because the opponent forfeited while it was in', () => {
  const m = real.moments.find((x) => x.rule === 'ko-streak');
  assert.strictEqual(m.facts.endedByForfeit, true);
  assert.strictEqual(m.facts.count, 2);
  assert.deepStrictEqual(m.facts.kos.map((k) => [k.turn, k.oppMon]), [[20, 'Urshifu'], [21, 'Appletun']]);
  assert.match(m.facts.whyKnowable, /the opponent forfeited while it was still in/);
});

// ---------------------------------------------------------------------------
// A tiny battle builder. I am p1 (Alice). Turn 1 is always Charizard's Flamethrower on my lead
// (it reveals the move); later turns come from `turns`. A team entry is
// [name, condition, item, ability]; the first entry is my active Pokémon.
// ---------------------------------------------------------------------------
function request(team, moves = ['Tackle']) {
  return {
    active: [{ moves: moves.map((m) => ({ move: m, id: m.toLowerCase().replace(/[^a-z0-9]/g, ''), pp: 10, maxpp: 10 })) }],
    side: {
      name: 'Alice', id: 'p1',
      pokemon: team.map(([name, condition, item, ability], i) => ({
        ident: `p1: ${name}`, details: `${name}, L80`, condition, active: i === 0, moves: ['tackle'],
        ...(item ? { item } : {}), ...(ability ? { ability } : {}),
      })),
    },
  };
}

function game({ turns, end = [], mine = 'Snorlax', theirs = 'Charizard', config }) {
  const lines = [
    '|init|battle', '|gametype|singles', '|player|p1|Alice|1|1000', '|player|p2|Bob|2|1000',
    '|gen|9', '|tier|[Gen 9] Random Battle', '|start',
    `|switch|p1a: ${mine}|${mine}, L80|100/100`, `|switch|p2a: ${theirs}|${theirs}, L80|100/100`,
  ];
  turns.forEach((t, i) => {
    lines.push(`|turn|${i + 1}`, `|request|${JSON.stringify(request(t.team, t.moves))}`, ...t.body);
  });
  lines.push(...end);
  return buildReview(buildBattle(lines), { room: 'mini', config });
}

const rules = (r) => r.moments.map((m) => [m.turn, m.rule, m.label]);

// Turn 1 reveals Flamethrower. Turn 2: Snorlax is out, Venusaur (weak to Fire) comes in, with
// Gengar (neutral to Fire) on the bench unless `bench` says otherwise.
const reveal = { team: [['Snorlax', '100/100'], ['Venusaur', '100/100'], ['Gengar', '100/100']], body: ['|move|p2a: Charizard|Flamethrower|p1a: Snorlax', '|-damage|p1a: Snorlax|90/100'] };
function risky({ body, venusaur = ['Venusaur', '100/100'], bench = [['Gengar', '100/100']], first = reveal.body, config }) {
  return game({
    turns: [
      { team: reveal.team, body: first },
      { team: [['Snorlax', '90/100'], venusaur, ...bench], body: ['|switch|p1a: Venusaur|Venusaur, L80|100/100', ...body] },
    ],
    config,
  });
}
const noHit = ['|move|p2a: Charizard|Tackle|p1a: Venusaur', '|-damage|p1a: Venusaur|95/100'];

test('risky-switch: fires when the revealed super-effective move did not come (hand-built)', () => {
  const r = risky({ body: noHit });
  assert.deepStrictEqual(rules(r), [[2, 'risky-switch', 'mistake']]);
  const f = r.moments[0].facts;
  assert.strictEqual(f.whatHappened, 'Charizard used Tackle instead, so the hit did not come this time');
  assert.deepStrictEqual(f.saferOption, { name: 'Gengar', multiplier: 1, hpPct: 100 });
});

test('risky-switch: a switch-in that was hit by the super-effective move is only switched-into-super-effective', () => {
  const big = risky({ body: ['|move|p2a: Charizard|Flamethrower|p1a: Venusaur', '|-supereffective|p1a: Venusaur', '|-damage|p1a: Venusaur|40/100'] });
  assert.deepStrictEqual(rules(big), [[2, 'switched-into-super-effective', 'blunder']]);
  // Too small to flag (below the 25% mistake threshold): still no second opinion from risky-switch.
  const small = risky({ body: ['|move|p2a: Charizard|Flamethrower|p1a: Venusaur', '|-supereffective|p1a: Venusaur', '|-damage|p1a: Venusaur|90/100'] });
  assert.deepStrictEqual(small.moments, []);
});

test('risky-switch: does NOT fire when the opponent switched, was asleep, or only showed a status move', () => {
  const switched = risky({ body: ['|switch|p2a: Moltres|Moltres, L80|100/100', '|move|p2a: Moltres|Tackle|p1a: Venusaur', '|-damage|p1a: Venusaur|95/100'] });
  assert.deepStrictEqual(switched.moments, []);
  const asleep = risky({
    first: [...reveal.body, '|-status|p2a: Charizard|slp'],
    body: ['|cant|p2a: Charizard|slp'],
  });
  assert.deepStrictEqual(asleep.moments, []);
  const statusOnly = risky({ first: ['|move|p2a: Charizard|Will-O-Wisp|p1a: Snorlax'], body: noHit });
  assert.deepStrictEqual(statusOnly.moments, []);
});

test('risky-switch: a revealed pivot move (U-turn) is not treated as the threat', () => {
  // U-turn is a Bug move and Grumpig (Psychic) is weak to Bug: the same situation as turn 24 of
  // the 35-turn log.
  const first = ['|move|p2a: Charizard|U-turn|p1a: Snorlax', '|-damage|p1a: Snorlax|90/100'];
  const body = ['|switch|p1a: Grumpig|Grumpig, L80|100/100', '|move|p2a: Charizard|Tackle|p1a: Grumpig', '|-damage|p1a: Grumpig|95/100'];
  const team1 = [['Snorlax', '100/100'], ['Grumpig', '100/100'], ['Gengar', '100/100']];
  const team2 = [['Snorlax', '90/100'], ['Grumpig', '100/100'], ['Gengar', '100/100']];
  const run = (firstLines) => game({ turns: [{ team: team1, body: firstLines }, { team: team2, body }] });
  assert.deepStrictEqual(run(first).moments, []);
  // Control: with a non-pivot Bug move (Bug Buzz) the same switch is flagged, so the pivot skip is what silenced it.
  const control = run(['|move|p2a: Charizard|Bug Buzz|p1a: Snorlax', '|-damage|p1a: Snorlax|90/100']);
  assert.deepStrictEqual(rules(control), [[2, 'risky-switch', 'mistake']]);
});

test('risky-switch: does NOT fire when my Pokémon\'s own ability or item deals with the move', () => {
  // Control: the same switch with no special ability fires (see the first test).
  const flashFire = risky({ body: noHit, venusaur: ['Venusaur', '100/100', null, 'flashfire'] });
  assert.deepStrictEqual(flashFire.moments, []);
  const policy = risky({ body: noHit, venusaur: ['Venusaur', '100/100', 'weaknesspolicy'] });
  assert.deepStrictEqual(policy.moments, []);
});

test('risky-switch: does NOT fire without a fair alternative on the bench', () => {
  // The only other option is also weak to Fire.
  const alsoWeak = risky({ body: noHit, bench: [['Tangela', '100/100']] });
  assert.deepStrictEqual(alsoWeak.moments, []);
  // The neutral option is too hurt to recommend (below 50% HP).
  const hurt = risky({ body: noHit, bench: [['Gengar', '30/100']] });
  assert.deepStrictEqual(hurt.moments, []);
  // No bench at all.
  assert.deepStrictEqual(risky({ body: noHit, bench: [] }).moments, []);
});

// ---------------------------------------------------------------------------
// ko-streak and forfeits
// ---------------------------------------------------------------------------

// Snorlax knocks out `n` opponents in a row (like review-new-rules.test.js). `after` adds a turn
// in which Alice switches to Venusaur, so Snorlax's stay is over before the game ends.
function koGame(n, { end = [], after = false, config } = {}) {
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
  if (after) turns.push({ team, moves: ['Body Slam'], body: ['|switch|p1a: Venusaur|Venusaur, L80|100/100'] });
  return game({ turns, end, config });
}
const BOB_FORFEITS = ['|-message|Bob forfeited.', '|win|Alice'];
const ALICE_FORFEITS = ['|-message|Alice forfeited.', '|win|Bob'];
const streak = (r) => r.moments.find((m) => m.rule === 'ko-streak');

test('ko-streak: two knockouts count when the opponent forfeits with the Pokémon still in', () => {
  const r = koGame(2, { end: BOB_FORFEITS });
  assert.deepStrictEqual(rules(r), [[2, 'ko-streak', 'great']]); // it replaces the found-the-ko on turn 2
  assert.strictEqual(streak(r).facts.endedByForfeit, true);
  assert.strictEqual(streak(r).facts.count, 2);
  assert.match(streak(r).facts.whyKnowable, /forfeited while it was still in/);
});

test('ko-streak: a won-by-forfeit game with only one knockout gives no streak', () => {
  assert.strictEqual(streak(koGame(1, { end: BOB_FORFEITS })), undefined);
});

test('ko-streak: two knockouts do NOT count without a forfeit, if the stay ended, or if I forfeited', () => {
  assert.strictEqual(streak(koGame(2)), undefined);
  assert.strictEqual(streak(koGame(2, { end: BOB_FORFEITS, after: true })), undefined); // Snorlax left before the forfeit
  assert.strictEqual(streak(koGame(2, { end: ALICE_FORFEITS })), undefined);
});

test('ko-streak: endedByForfeit is false for an ordinary streak and the threshold is configurable', () => {
  assert.strictEqual(streak(koGame(3)).facts.endedByForfeit, false);
  assert.strictEqual(streak(koGame(3, { end: BOB_FORFEITS })).facts.endedByForfeit, true);
  assert.strictEqual(streak(koGame(2, { end: BOB_FORFEITS, config: { koStreakMinBeforeForfeit: 3 } })), undefined);
});
