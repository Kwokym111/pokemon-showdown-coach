// Tests for the move-choice rules in review.js: missed-ko, weak-move-choice, found-the-ko.
// They use hand-made one-turn duels, because the real logs have almost no qualifying turns
// (and that quietness on real logs is itself tested at the bottom).
//
// The numbers come from damage.js and match calc.pokemonshowdown.com (everything at 84 EVs,
// neutral nature). L80 Garchomp vs L82 Gholdengo, as % of Gholdengo's max HP:
//   Earthquake 78.7-93.8   Fire Fang 34.6-41.1   Outrage 23.8-28.1
//   Dragon Claw 15.8-18.7  Stone Edge 12.9-15.5  Iron Head 10.4-12.6

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildBattle } = require('../src/core/state');
const { buildReview, describeMoveChoices, CONFIG } = require('../src/core/review');

const toId = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const RULES = ['missed-ko', 'weak-move-choice', 'found-the-ko'];

const MISS_KEYS = ['myMon', 'myMove', 'myMoveMinPct', 'myMoveMaxPct', 'betterMove', 'betterMoveMinPct', 'betterMoveMaxPct', 'oppMon', 'oppTypes', 'oppHpPct', 'oppAbilityKnown', 'knowable', 'whyKnowable'];
const FOUND_KEYS = ['myMon', 'myMove', 'myMoveMinPct', 'myMoveMaxPct', 'bestOtherMove', 'bestOtherMaxPct', 'oppMon', 'oppTypes', 'oppHpPct', 'knowable', 'whyKnowable'];

// One turn of Garchomp (me) against `opp` at `oppHp`% HP. `avail` is my move list in the
// request (names, or { name, disabled }). `body` are the log lines of the turn.
function duel({ me = 'p1', opp = 'Gholdengo', oppLevel = 82, oppHp = 100, lead = null, avail, body, pre = [] }) {
  const them = me === 'p1' ? 'p2' : 'p1';
  const moves = avail.map((a) => (typeof a === 'string' ? { name: a } : a));
  const request = {
    side: {
      name: me === 'p1' ? 'Alice' : 'Bob', id: me,
      pokemon: [{
        ident: `${me}: Garchomp`, details: 'Garchomp, L80', condition: '304/304', active: true,
        item: '', ability: 'sandveil', moves: moves.map((m) => toId(m.name)),
      }],
    },
    active: [{ moves: moves.map((m) => ({ move: m.name, id: toId(m.name), pp: 10, maxpp: 16, disabled: !!m.disabled })) }],
  };
  const lines = [
    '|init|battle', '|gametype|singles', '|player|p1|Alice|1|1000', '|player|p2|Bob|2|1000',
    '|gen|9', '|tier|[Gen 9] Random Battle', '|start',
    `|switch|${me}a: Garchomp|Garchomp, L80|304/304`,
    `|switch|${them}a: ${lead || opp}|${lead || opp}, L${oppLevel}|${oppHp}/100`,
    ...pre,
    // As in a real log: a request before turn 1 (it carries my team and moves), and one
    // right after |turn|1 (the choices for that turn).
    `|request|${JSON.stringify(request)}`,
    '|turn|1', `|request|${JSON.stringify(request)}`, ...body,
  ];
  const battle = buildBattle(lines);
  return { review: buildReview(battle, { room: 'duel' }), battle, them };
}

const hit = (me, move, afterHp, target = 'Gholdengo') => {
  const them = me === 'p1' ? 'p2' : 'p1';
  return [`|move|${me}a: Garchomp|${move}|${them}a: ${target}`, `|-damage|${them}a: ${target}|${afterHp}/100`];
};
const ko = (me, move, target = 'Gholdengo') => {
  const them = me === 'p1' ? 'p2' : 'p1';
  return [`|move|${me}a: Garchomp|${move}|${them}a: ${target}`, `|-damage|${them}a: ${target}|0 fnt`, `|faint|${them}a: ${target}`];
};
const flagged = (r) => r.moments.filter((m) => RULES.includes(m.rule));

// ---------------------------------------------------------------------------
// missed-ko
// ---------------------------------------------------------------------------

test('missed-ko: Dragon Claw into a Gholdengo at 50% when Earthquake surely KOs', () => {
  const { review } = duel({ oppHp: 50, avail: ['Earthquake', 'Dragon Claw'], body: hit('p1', 'Dragon Claw', 33) });
  const m = flagged(review);
  assert.strictEqual(m.length, 1);
  assert.deepStrictEqual([m[0].turn, m[0].rule, m[0].label, m[0].mon, m[0].title], [1, 'missed-ko', 'mistake', 'Garchomp', 'Missed a knockout']);
  assert.deepStrictEqual(Object.keys(m[0]), ['turn', 'rule', 'label', 'mon', 'title', 'explanation', 'facts']);
  assert.deepStrictEqual(Object.keys(m[0].facts), MISS_KEYS);
  assert.deepStrictEqual(m[0].facts, {
    myMon: 'Garchomp', myMove: 'Dragon Claw', myMoveMinPct: 15.8, myMoveMaxPct: 18.7,
    betterMove: 'Earthquake', betterMoveMinPct: 78.7, betterMoveMaxPct: 93.8,
    oppMon: 'Gholdengo', oppTypes: ['Steel', 'Ghost'], oppHpPct: 50, oppAbilityKnown: false, knowable: true,
    whyKnowable: 'Gholdengo was at 50% HP and Earthquake does 78.7-93.8% to it, enough to knock it out; it was one of your available moves',
  });
});

test('missed-ko: works when the player is p2, and the review is repeatable', () => {
  const a = duel({ me: 'p2', oppHp: 50, avail: ['Earthquake', 'Dragon Claw'], body: hit('p2', 'Dragon Claw', 33) });
  assert.deepStrictEqual(flagged(a.review).map((m) => m.rule), ['missed-ko']);
  assert.deepStrictEqual(buildReview(a.battle, { room: 'duel' }), a.review);
});

test('missed-ko: quiet when my move also KOs, or the better move is inside the 10-point margin', () => {
  // Fire Fang (34.6-41.1) at 30% HP KOs for sure itself.
  assert.deepStrictEqual(flagged(duel({ oppHp: 30, avail: ['Earthquake', 'Fire Fang'], body: ko('p1', 'Fire Fang') }).review).filter((m) => m.rule === 'missed-ko'), []);
  // Earthquake's minimum (78.7) is only 4.7 above a 74% target: a KO, but inside the margin, so
  // it is not called a missed KO. It is still a far better move, so weak-move-choice speaks.
  const close = flagged(duel({ oppHp: 74, avail: ['Earthquake', 'Dragon Claw'], body: hit('p1', 'Dragon Claw', 56) }).review);
  assert.deepStrictEqual(close.map((m) => m.rule), ['weak-move-choice']);
});

test('missed-ko: the margin and thresholds live in CONFIG and can be changed per call', () => {
  const { battle } = duel({ oppHp: 74, avail: ['Earthquake', 'Dragon Claw'], body: hit('p1', 'Dragon Claw', 56) });
  assert.deepStrictEqual(flagged(buildReview(battle, { room: 'x', config: { koMarginPct: 0 } })).map((m) => m.rule), ['missed-ko']);
  assert.strictEqual(CONFIG.koMarginPct, 10); // the shared default was not changed
});

test('missed-ko: not judged when I did not attack, or chose a deliberate move', () => {
  const avail = ['Earthquake', 'Dragon Claw', 'Aqua Jet', 'U-turn', 'Fake Out', 'Swords Dance', 'Explosion'];
  const base = { oppHp: 50, avail };
  for (const chosen of ['Aqua Jet', 'U-turn', 'Fake Out', 'Explosion']) {
    assert.deepStrictEqual(flagged(duel({ ...base, body: hit('p1', chosen, 40) }).review), [], chosen);
  }
  assert.deepStrictEqual(flagged(duel({ ...base, body: ['|move|p1a: Garchomp|Swords Dance|p1a: Garchomp', '|-boost|p1a: Garchomp|atk|2'] }).review), []);
  assert.deepStrictEqual(flagged(duel({ ...base, body: ['|switch|p1a: Zzz|Zzz, L80|100/100'] }).review), []);
});

test('missed-ko: the better move must be available: a choice-locked or empty-PP move is not an option', () => {
  const locked = duel({ oppHp: 50, avail: [{ name: 'Earthquake', disabled: true }, 'Dragon Claw'], body: hit('p1', 'Dragon Claw', 33) });
  assert.deepStrictEqual(flagged(locked.review), []);
});

test('missed-ko: a move that is too inaccurate, or only works in some situations, is not recommended', () => {
  // Blissey at 30%: Stone Edge (80% accuracy, 44-52%) would surely KO if it hit.
  const inaccurate = duel({ opp: 'Blissey', oppLevel: 80, oppHp: 30, avail: ['Fire Fang', 'Stone Edge'], body: hit('p1', 'Fire Fang', 5, 'Blissey') });
  assert.deepStrictEqual(flagged(inaccurate.review), []);
  assert.deepStrictEqual(flagged(buildReview(inaccurate.battle, { room: 'x', config: { minAccuracy: 80 } })).map((m) => [m.rule, m.facts.betterMove]), [['missed-ko', 'Stone Edge']]);
  // Blissey at 30%: Last Resort (only works after using every other move) would KO, but it is situational.
  const situational = duel({ opp: 'Blissey', oppLevel: 80, oppHp: 30, avail: ['Fire Fang', 'Last Resort'], body: hit('p1', 'Fire Fang', 5, 'Blissey') });
  assert.deepStrictEqual(flagged(situational.review), []);
  assert.deepStrictEqual(flagged(buildReview(situational.battle, { room: 'x', config: { conditionalMoves: [] } })).map((m) => m.facts.betterMove), ['Last Resort']);
});

test('missed-ko: a move that lowers my own stats can still be the KO I missed', () => {
  // Blissey at 60%: Close Combat (105.7-124.6) surely KOs; Fire Fang (28.7-33.9) does not.
  const r = duel({ opp: 'Blissey', oppLevel: 80, oppHp: 60, avail: ['Fire Fang', 'Close Combat'], body: hit('p1', 'Fire Fang', 30, 'Blissey') });
  assert.deepStrictEqual(flagged(r.review).map((m) => [m.rule, m.facts.betterMove]), [['missed-ko', 'Close Combat']]);
});

test('missed-ko: charge, recharge and self-destruct moves are not the recommended KO', () => {
  const r = duel({ opp: 'Blissey', oppLevel: 80, oppHp: 60, avail: ['Fire Fang', 'Explosion', 'Hyper Beam', 'Solar Beam'], body: hit('p1', 'Fire Fang', 30, 'Blissey') });
  assert.ok(!flagged(r.review).some((m) => ['Explosion', 'Hyper Beam', 'Solar Beam'].includes(m.facts.betterMove)));
});

test('missed-ko: the opponent switching in this turn is not held against the player', () => {
  // The Blissey that was on the field at 30% could be KO'd by Earthquake, so judged against it
  // Fire Fang would be a missed KO. But Gholdengo switched in and took the hit instead.
  const r = duel({
    opp: 'Blissey', oppLevel: 80, oppHp: 30, avail: ['Earthquake', 'Fire Fang'],
    body: ['|switch|p2a: Gholdengo|Gholdengo, L82|50/100', ...hit('p1', 'Fire Fang', 20)],
  });
  assert.deepStrictEqual(flagged(r.review), []);
  // Control: with no switch the same choice IS flagged.
  const control = duel({ opp: 'Blissey', oppLevel: 80, oppHp: 30, avail: ['Earthquake', 'Fire Fang'], body: hit('p1', 'Fire Fang', 5, 'Blissey') });
  assert.deepStrictEqual(flagged(control.review).map((m) => m.rule), ['missed-ko']);
});

test('missed-ko: an ability that could stop the better move means it is not a sure KO', () => {
  // Heatran has Flash Fire or Flame Body. Flare Blitz would be absorbed by Flash Fire.
  const avail = ['Iron Head', 'Flare Blitz'];
  const unknown = duel({ opp: 'Heatran', oppLevel: 80, oppHp: 15, avail, body: hit('p1', 'Iron Head', 12, 'Heatran') });
  assert.deepStrictEqual(flagged(unknown.review), []);
  // Once the log has shown Flame Body, the same turn IS a missed KO.
  const known = duel({
    opp: 'Heatran', oppLevel: 80, oppHp: 15, avail,
    pre: ['|-ability|p2a: Heatran|Flame Body'], body: hit('p1', 'Iron Head', 12, 'Heatran'),
  });
  const m = flagged(known.review);
  assert.deepStrictEqual(m.map((x) => [x.rule, x.facts.betterMove, x.facts.oppAbilityKnown]), [['missed-ko', 'Flare Blitz', true]]);
});

test('missed-ko: a Terastallization this turn is applied to my own damage', () => {
  const plain = duel({ oppHp: 50, avail: ['Earthquake', 'Dragon Claw'], body: hit('p1', 'Dragon Claw', 33) });
  const tera = duel({ oppHp: 50, avail: ['Earthquake', 'Dragon Claw'], body: ['|-terastallize|p1a: Garchomp|Ground', ...hit('p1', 'Dragon Claw', 33)] });
  const f = (r) => flagged(r.review)[0].facts;
  assert.ok(f(tera).betterMoveMinPct > f(plain).betterMoveMinPct, 'Tera Ground should raise Earthquake');
});

// ---------------------------------------------------------------------------
// weak-move-choice
// ---------------------------------------------------------------------------

test('weak-move-choice: a huge gap (Iron Head instead of Earthquake) is a blunder', () => {
  const { review } = duel({ avail: ['Earthquake', 'Iron Head'], body: hit('p1', 'Iron Head', 89) });
  const m = flagged(review);
  assert.strictEqual(m.length, 1);
  assert.deepStrictEqual([m[0].rule, m[0].label, m[0].title], ['weak-move-choice', 'blunder', 'Used a much weaker move than another option']);
  assert.deepStrictEqual(Object.keys(m[0].facts), MISS_KEYS);
  assert.deepStrictEqual([m[0].facts.myMove, m[0].facts.betterMove, m[0].facts.oppHpPct], ['Iron Head', 'Earthquake', 100]);
});

test('weak-move-choice: a big but smaller gap (Outrage instead of Earthquake) is a mistake', () => {
  const { review } = duel({ avail: ['Earthquake', 'Outrage'], body: hit('p1', 'Outrage', 74) });
  assert.deepStrictEqual(flagged(review).map((m) => [m.rule, m.label]), [['weak-move-choice', 'mistake']]);
});

test('weak-move-choice: quiet for a small gap, a close ratio, or when thresholds are not met', () => {
  // Fire Fang (up to 41.1) vs Earthquake (78.7): the gap is 37 but 41.1 is more than half of 78.7.
  assert.deepStrictEqual(flagged(duel({ avail: ['Earthquake', 'Fire Fang'], body: hit('p1', 'Fire Fang', 62) }).review), []);
  // The same choice is flagged if the ratio is tightened.
  const { battle } = duel({ avail: ['Earthquake', 'Fire Fang'], body: hit('p1', 'Fire Fang', 62) });
  assert.strictEqual(flagged(buildReview(battle, { room: 'x', config: { weakRatio: 0.6 } })).length, 1);
});

test('weak-move-choice: damage beyond the remaining HP of the opponent does not count', () => {
  // Gholdengo at 20%: Outrage (23.8-28.1) surely KOs, so Earthquake could do no more. It missed,
  // but the choice was fine. Without the cap, 78.7 vs 28.1 would look like a huge gap.
  const miss = ['|move|p1a: Garchomp|Outrage|p2a: Gholdengo|[miss]', '|-miss|p1a: Garchomp|p2a: Gholdengo'];
  const r = duel({ oppHp: 20, avail: ['Earthquake', 'Outrage'], body: miss });
  assert.deepStrictEqual(flagged(r.review), []);
  assert.strictEqual(describeMoveChoices(r.battle).length, 1); // it WAS judged, and found fine
});

test('weak-move-choice: not offered a locked-in, self-damaging, inaccurate or situational "better" move', () => {
  // Blissey at 100%: Iron Head (35-41) is the move used; every stronger option is unfit.
  const avail = ['Iron Head', 'Outrage', 'Close Combat', 'Stone Edge', 'Poltergeist', 'Hyper Beam'];
  const r = duel({ opp: 'Blissey', oppLevel: 80, avail, body: hit('p1', 'Iron Head', 60, 'Blissey') });
  assert.deepStrictEqual(flagged(r.review), []);
});

test('weak-move-choice: a move the log says was immune is left to move-into-immunity', () => {
  const r = duel({ opp: 'Corviknight', oppLevel: 80, avail: ['Earthquake', 'Fire Fang'], body: ['|move|p1a: Garchomp|Earthquake|p2a: Corviknight', '|-immune|p2a: Corviknight'] });
  assert.ok(!flagged(r.review).length);
});

test('weak-move-choice: missed-ko takes the turn (one moment per decision)', () => {
  const r = duel({ oppHp: 50, avail: ['Earthquake', 'Iron Head'], body: hit('p1', 'Iron Head', 40) });
  assert.deepStrictEqual(flagged(r.review).map((m) => m.rule), ['missed-ko']);
});

// ---------------------------------------------------------------------------
// found-the-ko
// ---------------------------------------------------------------------------

test('found-the-ko: the knockout was only possible with the move used', () => {
  const { review } = duel({ oppHp: 50, avail: ['Earthquake', 'Dragon Claw'], body: ko('p1', 'Earthquake') });
  const m = flagged(review);
  assert.strictEqual(m.length, 1);
  assert.deepStrictEqual([m[0].rule, m[0].label, m[0].title], ['found-the-ko', 'good', 'Found the knockout']);
  assert.deepStrictEqual(Object.keys(m[0].facts), FOUND_KEYS);
  assert.deepStrictEqual(m[0].facts, {
    myMon: 'Garchomp', myMove: 'Earthquake', myMoveMinPct: 78.7, myMoveMaxPct: 93.8,
    bestOtherMove: 'Dragon Claw', bestOtherMaxPct: 18.7,
    oppMon: 'Gholdengo', oppTypes: ['Steel', 'Ghost'], oppHpPct: 50, knowable: true,
    whyKnowable: 'Gholdengo was at 50% HP, Earthquake does 78.7-93.8% to it, and none of your other moves could do enough',
  });
});

test('found-the-ko: quiet when another move could also have done it, or there was no other attack', () => {
  // Fire Fang tops out at 41.1, plus the 10-point margin that is 51.1, which reaches 50%.
  assert.deepStrictEqual(flagged(duel({ oppHp: 50, avail: ['Earthquake', 'Fire Fang'], body: ko('p1', 'Earthquake') }).review), []);
  assert.deepStrictEqual(flagged(duel({ oppHp: 50, avail: ['Earthquake'], body: ko('p1', 'Earthquake') }).review), []);
  assert.deepStrictEqual(flagged(duel({ oppHp: 50, avail: ['Earthquake', 'Swords Dance'], body: ko('p1', 'Earthquake') }).review), []);
});

test('found-the-ko: the opponent switching in this turn is not judged', () => {
  const r = duel({ lead: 'Blissey', oppHp: 50, avail: ['Earthquake', 'Dragon Claw'], body: ['|switch|p2a: Gholdengo|Gholdengo, L82|50/100', ...ko('p1', 'Earthquake')] });
  assert.deepStrictEqual(flagged(r.review), []);
});

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

test('no |request| for the turn (options not captured): nothing is judged', () => {
  const lines = [
    '|init|battle', '|gametype|singles', '|player|p1|Alice|1|1000', '|player|p2|Bob|2|1000', '|gen|9', '|tier|[Gen 9] Random Battle', '|start',
    '|switch|p1a: Garchomp|Garchomp, L80|100/100', '|switch|p2a: Gholdengo|Gholdengo, L82|50/100',
    '|turn|1', ...hit('p1', 'Dragon Claw', 33),
  ];
  assert.deepStrictEqual(buildReview(buildBattle(lines), { room: 'x' }).moments, []);
  assert.deepStrictEqual(describeMoveChoices(buildBattle(lines)), []);
});

test('describeMoveChoices lists the options and ranges the rules saw', () => {
  const { battle } = duel({ oppHp: 50, avail: ['Earthquake', 'Dragon Claw'], body: hit('p1', 'Dragon Claw', 33) });
  const [row] = describeMoveChoices(battle);
  assert.deepStrictEqual([row.turn, row.oppMon, row.oppHpPct, row.chosen], [1, 'Gholdengo', 50, 'Dragon Claw']);
  assert.deepStrictEqual(row.options.map((o) => [o.name, o.minPct, o.maxPct, o.guaranteedKo]), [['Dragon Claw', 15.8, 18.7, false], ['Earthquake', 78.7, 93.8, true]]);
});

test('real logs: the new rules stay quiet where the choice was reasonable, and keep the shape', () => {
  const dir = path.join(__dirname, '..', 'test-data');
  let found = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.log'))) {
    const review = buildReview(buildBattle(fs.readFileSync(path.join(dir, f), 'utf8').split('\n')), { room: f });
    for (const m of flagged(review)) {
      found++;
      assert.deepStrictEqual(Object.keys(m.facts), m.rule === 'found-the-ko' ? FOUND_KEYS : MISS_KEYS);
      assert.ok(m.explanation === null && m.facts.knowable === true);
      // Nothing in the real logs is a clear missed KO or blunder: all were reasonable choices.
      assert.notStrictEqual(m.label, 'blunder', `${f} turn ${m.turn}`);
      assert.notStrictEqual(m.rule, 'missed-ko', `${f} turn ${m.turn}`);
    }
  }
  assert.ok(found >= 1, 'expected at least one found-the-ko on the real logs');
});
