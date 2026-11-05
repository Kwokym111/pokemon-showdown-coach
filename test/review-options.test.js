// Tests for moment.options (display-only: the moves and bench the player had on a decision).
// Uses the 35-turn demo log, where turn 12 is a replacement after a faint and turn 18 is a
// replacement after a U-turn.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildBattle } = require('../src/core/state');
const { buildReview } = require('../src/core/review');
const { applyCachedExplanations } = require('../src/core/review-cache');
const { buildPrompt } = require('../src/main/ai');

const DIR = path.join(__dirname, '..', 'test-data');
const DEMO = 'battle-gen9randombattle-2707352165-ghpcomhxs9xljqkvhxs3ufwfmwhjj0qpw.log';
const lines = (f) => fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/);
const demo = () => buildReview(buildBattle(lines(DEMO)), { room: 'demo' });
const at = (review, turn) => review.moments.find((m) => m.turn === turn);

test('turn 12 (bad-replacement) lists the bench I could send in, not the fainted mon\'s moves', () => {
  const o = at(demo(), 12).options;
  assert.strictEqual(o.kind, 'replacement');
  assert.strictEqual(o.active, null);
  assert.deepStrictEqual(o.moves, []);
  assert.strictEqual(o.canTerastallize, null);
  // Includes Masquerain, the Pokémon actually sent in: it was one of the options.
  assert.deepStrictEqual(o.bench.map((b) => b.name), ['Chien-Pao', 'Ambipom', 'Grumpig', 'Masquerain', 'Sceptile']);
  assert.ok(Math.abs(o.bench[4].hpPct - 24.6) < 0.1);
});

test('turn 18 (low-hp-switch-in after a U-turn) is a replacement, not Ambipom\'s move list', () => {
  const o = at(demo(), 18).options;
  assert.strictEqual(o.kind, 'replacement');
  assert.deepStrictEqual(o.moves, []);
  assert.deepStrictEqual(o.bench.map((b) => b.name), ['Chien-Pao', 'Grumpig', 'Sceptile']);
});

test('a normal turn shows the moves with the chosen one marked used, and Tera when available', () => {
  const review = demo();
  const t4 = at(review, 4).options;
  assert.strictEqual(t4.kind, 'turn');
  assert.strictEqual(t4.active, 'Sceptile');
  assert.deepStrictEqual(t4.moves.map((m) => [m.name, m.type, m.used]), [
    ['Giga Drain', 'Grass', true], ['Focus Blast', 'Fighting', false], ['Leech Seed', 'Grass', false], ['Substitute', 'Normal', false],
  ]);
  assert.strictEqual(t4.canTerastallize, 'Steel');
  assert.ok(t4.bench.every((b) => b.name && 'hpPct' in b && 'status' in b && !('item' in b) && !('ability' in b)));

  // Turn 7: Giga Drain was disabled, and Leech Seed (which failed) is the one used.
  const t7 = at(review, 7).options;
  assert.strictEqual(t7.moves.find((m) => m.name === 'Giga Drain').disabled, true);
  assert.deepStrictEqual(t7.moves.filter((m) => m.used).map((m) => m.name), ['Leech Seed']);
  assert.strictEqual(t7.canTerastallize, null);
});

test('options is the last key of every moment, on every real log, and never throws', () => {
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.log'))) {
    const review = buildReview(buildBattle(lines(f)), { room: 'r' });
    for (const m of review.moments) {
      assert.strictEqual(Object.keys(m).pop(), 'options', f);
      assert.ok(m.options === null || ['turn', 'replacement'].includes(m.options.kind), f);
    }
    assert.deepStrictEqual(JSON.parse(JSON.stringify(review)), review);
  }
});

test('missing request data gives options: null instead of throwing', () => {
  const battle = buildBattle(lines(DEMO));
  for (const t of battle.turns) { t.available = null; t.forceSwitch = null; }
  const review = buildReview(battle, { room: 'r' });
  assert.ok(review.moments.length > 0);
  assert.ok(review.moments.every((m) => m.options === null));
});

test('options never reach the AI prompt', () => {
  const review = demo();
  const { user, system } = buildPrompt(review);
  assert.ok(!user.includes('"options"') && !system.includes('"options"'));
  // A bench name that no moment's facts mention must not appear anywhere in the prompt.
  const factsText = JSON.stringify(review.moments.map((m) => m.facts));
  const benchOnly = new Set();
  for (const m of review.moments) for (const b of m.options.bench) if (!factsText.includes(b.name)) benchOnly.add(b.name);
  assert.ok(benchOnly.size > 0, 'the demo log should have bench names that are not in any facts');
  for (const name of benchOnly) assert.ok(!user.includes(name), `${name} leaked into the prompt`);
  // And the review itself is not changed by building the prompt.
  assert.ok(review.moments.every((m) => m.options !== undefined));
});

test('a cached review still shows options (they come from the rebuilt review)', () => {
  const fresh = demo();
  // A cache file as written before this field existed: no options on its moments.
  const cached = {
    ...fresh, aiUsed: true, summary: 'Summary.',
    moments: fresh.moments.map((m) => { const { options, ...rest } = m; return { ...rest, explanation: 'Words.' }; }),
  };
  const out = applyCachedExplanations(fresh, cached);
  assert.ok(out);
  assert.deepStrictEqual(out.moments.map((m) => m.options), fresh.moments.map((m) => m.options));
  assert.ok(out.moments.every((m) => m.explanation === 'Words.'));
});
