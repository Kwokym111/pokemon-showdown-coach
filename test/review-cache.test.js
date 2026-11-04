// Tests for review-cache.js: a cached AI review is only reused when the moments match.

const test = require('node:test');
const assert = require('node:assert');
const { applyCachedExplanations } = require('../src/core/review-cache');

const moment = (turn, rule, label, mon, explanation = null) => ({ turn, rule, label, mon, title: 't', explanation, facts: { a: 1 } });
const review = () => ({
  version: 1, room: 'r', players: { me: 'a', opponent: 'b' }, result: { won: true, forfeit: false, lastTurn: 9 },
  aiUsed: false, summary: null,
  moments: [moment(3, 'found-the-ko', 'good', 'Gengar'), moment(7, 'missed-ko', 'mistake', 'Ceruledge')],
});
const cached = () => ({
  ...review(), aiUsed: true, summary: 'You did well.',
  moments: [moment(3, 'found-the-ko', 'good', 'Gengar', 'Nice KO.'), moment(7, 'missed-ko', 'mistake', 'Ceruledge', 'Another move won.')],
});

test('matching moments get the cached summary and explanations', () => {
  const out = applyCachedExplanations(review(), cached());
  assert.strictEqual(out.aiUsed, true);
  assert.strictEqual(out.summary, 'You did well.');
  assert.deepStrictEqual(out.moments.map((m) => m.explanation), ['Nice KO.', 'Another move won.']);
});

test('the fresh review supplies everything else and is not modified', () => {
  const fresh = review();
  const out = applyCachedExplanations(fresh, cached());
  assert.deepStrictEqual(out.moments[0].facts, fresh.moments[0].facts);
  assert.strictEqual(fresh.aiUsed, false);
  assert.strictEqual(fresh.moments[0].explanation, null);
});

test('a changed label, rule, turn or Pokémon invalidates the cache', () => {
  for (const [i, key, value] of [[0, 'label', 'great'], [0, 'rule', 'other-rule'], [1, 'turn', 8], [1, 'mon', 'Gengar']]) {
    const c = cached();
    c.moments[i][key] = value;
    assert.strictEqual(applyCachedExplanations(review(), c), null, `${key} changed`);
  }
});

test('a different number of moments invalidates the cache', () => {
  const c = cached();
  c.moments.pop();
  assert.strictEqual(applyCachedExplanations(review(), c), null);
});

test('a cache without AI text is not used', () => {
  assert.strictEqual(applyCachedExplanations(review(), null), null);
  assert.strictEqual(applyCachedExplanations(review(), { ...cached(), aiUsed: false }), null);
  assert.strictEqual(applyCachedExplanations(review(), { ...cached(), summary: null }), null);
  const c = cached();
  c.moments[1].explanation = null;
  assert.strictEqual(applyCachedExplanations(review(), c), null);
});

test('aiModel is carried over from the cache when present, and left out when not', () => {
  assert.strictEqual(applyCachedExplanations(review(), { ...cached(), aiModel: 'gemini-x' }).aiModel, 'gemini-x');
  assert.strictEqual('aiModel' in applyCachedExplanations(review(), cached()), false);
});
