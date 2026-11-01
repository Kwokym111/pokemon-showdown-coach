// Tests for state.js. Part 1 runs every real log in test-data/ against facts counted
// straight from the raw lines (so the test does not just repeat the parser's own logic).
// Part 2 uses tiny hand-made logs for edge cases the real logs do not contain.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildBattle, toId } = require('../src/core/state');
const { stripRank } = require('../src/core/parser');

const DIR = path.join(__dirname, '..', 'test-data');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.log'));
const readLines = (f) => fs.readFileSync(path.join(DIR, f), 'utf8').split('\n');

// buildBattle starts over at every |init|battle, so facts must be counted after the last one.
function afterLastInit(lines) {
  const i = lines.lastIndexOf('|init|battle');
  return i === -1 ? lines : lines.slice(i);
}
const count = (lines, re) => lines.filter((l) => re.test(l)).length;

test('there are real logs to test against', () => {
  assert.ok(files.length >= 8, `only ${files.length} logs in test-data/`);
});

for (const f of files) {
  test(`real log ${f}: header, players, counts`, () => {
    const lines = afterLastInit(readLines(f));
    const b = buildBattle(readLines(f));

    // Header
    assert.strictEqual(b.gen, 9);
    assert.strictEqual(b.format, '[Gen 9] Random Battle');
    assert.strictEqual(b.gameType, 'singles');
    assert.strictEqual(b.rated, lines.includes('|rated|'));

    // Players and "me": the player is NOT always p1, it comes from |request|.
    assert.ok(b.players.p1 && b.players.p1.name, 'p1 name');
    assert.ok(b.players.p2 && b.players.p2.name, 'p2 name');
    assert.strictEqual(b.players[b.me].name, 'cool213');

    // Turns are numbered 0..N with no gaps, N = highest |turn|.
    const maxTurn = Math.max(0, ...lines.filter((l) => /^\|turn\|\d+$/.test(l)).map((l) => Number(l.split('|')[2])));
    assert.deepStrictEqual(b.turns.map((t) => t.turn), Array.from({ length: maxTurn + 1 }, (_, i) => i));
    assert.strictEqual(b.result.lastTurn, maxTurn);

    // Nothing invented, nothing dropped: totals match a plain count of the raw lines.
    const sum = (key) => b.turns.reduce((n, t) => n + t[key].length, 0);
    assert.strictEqual(sum('moves'), count(lines, /^\|move\|/));
    assert.strictEqual(sum('faints'), count(lines, /^\|faint\|/));
    assert.strictEqual(sum('switches'), count(lines, /^\|(switch|drag)\|/));
    assert.strictEqual(sum('teras'), count(lines, /^\|-terastallize\|/));

    // Every command was either understood or deliberately ignored.
    assert.deepStrictEqual(b.warnings.unknownCommands, {});
  });

  test(`real log ${f}: result, forfeit, HP`, () => {
    const lines = afterLastInit(readLines(f));
    const b = buildBattle(readLines(f));

    const winLine = lines.find((l) => l.startsWith('|win|'));
    assert.strictEqual(b.result.winner, winLine ? stripRank(winLine.split('|')[2]) : null);

    const forfeitLine = lines.map((l) => /^\|-message\|(.*) forfeited\.$/.exec(l)).find(Boolean);
    assert.strictEqual(b.result.forfeit, !!forfeitLine);
    assert.strictEqual(b.result.forfeiter, forfeitLine ? stripRank(forfeitLine[1]) : null);

    for (const t of b.turns) {
      for (const snapshot of [t.start, t.end]) {
        if (!snapshot) continue;
        for (const side of ['p1', 'p2']) {
          const m = snapshot[side];
          if (!m) continue;
          assert.ok(m.hp <= m.maxHp, `${f} turn ${t.turn}: ${m.name} hp ${m.hp} > max ${m.maxHp}`);
          assert.ok(m.hpPct >= 0 && m.hpPct <= 100, `${f} turn ${t.turn}: hpPct ${m.hpPct}`);
          // The opponent is always a percentage. My own side is real HP live, but a
          // percentage in history replayed after a reload, so only check it is consistent.
          if (side !== b.me) { assert.strictEqual(m.hpKind, 'percent'); assert.strictEqual(m.maxHp, 100); }
          else assert.strictEqual(m.hpKind, m.maxHp === 100 ? 'percent' : 'real');
        }
      }
    }
  });
}

test('real logs: every move I used was among my available moves that turn', () => {
  let checked = 0;
  for (const f of files) {
    const b = buildBattle(readLines(f));
    for (const t of b.turns) {
      if (!t.available) continue; // not captured (see the reload test below), nothing to check
      for (const m of t.moves) {
        if (m.side !== b.me || m.source) continue; // moves called by other moves ([from]) are not in the list
        if (toId(m.move) === 'struggle') continue;
        checked++;
        assert.ok(t.available.moves.some((a) => toId(a.name) === toId(m.move)), `${f} turn ${t.turn}: ${m.move} not in available moves`);
      }
    }
  }
  assert.ok(checked > 40, `only ${checked} moves could be checked`);
});

test('real log: Tera-Ghost makes Close Combat have no effect (turn 1)', () => {
  const b = buildBattle(readLines('battle-gen9randombattle-2707357132.log'));
  const t1 = b.turns[1];
  assert.deepStrictEqual(t1.teras.map((t) => [t.mon, t.teraType]), [['Vigoroth', 'Ghost']]);
  const cc = t1.moves.find((m) => m.move === 'Close Combat');
  assert.strictEqual(cc.effectiveness, 'immune');
  assert.strictEqual(cc.damagePct, 0);
  // Tera is recorded on the Pokémon too, so task 4 can work out its current type.
  assert.strictEqual(t1.end.p1.terastallized, true);
  assert.strictEqual(t1.end.p1.teraType, 'Ghost');
  // The lead-in turn has no start snapshot and no choices.
  assert.strictEqual(b.turns[0].start, null);
  assert.strictEqual(b.turns[0].available, null);
  assert.strictEqual(t1.available.canTerastallize, 'Fire');
});

test('real logs: forfeit at the start leaves a final turn with no moves', () => {
  // 2707569201 was a very short forfeited game: the review must not invent moments.
  const b = buildBattle(readLines('battle-gen9randombattle-2707569201.log'));
  assert.strictEqual(b.result.forfeit, true);
  const last = b.turns[b.turns.length - 1];
  assert.strictEqual(last.moves.length, 0);
});

test('real log: repeat_refresh.log is read as ONE battle (history replays reset the state)', () => {
  const b = buildBattle(readLines('repeat_refresh.log'));
  assert.strictEqual(b.turns.length - 1, 3);
  assert.strictEqual(b.turns[0].switches.length, 2); // the two leads, once, not five times over
});

test('real log: reconnect lines "|player|p2|" do not erase the player, and replayed history has no old requests', () => {
  const lines = readLines('repeat_refresh_fixed.log');
  assert.ok(lines.includes('|player|p2|'), 'fixture should contain a bare |player|p2| line');
  const b = buildBattle(lines);
  assert.strictEqual(b.players.p2.name, 'cool213');
  assert.strictEqual(b.me, 'p2');
  assert.strictEqual(b.result.winner, stripRank(lines.find((l) => l.startsWith('|win|')).split('|')[2]));
  // After a reload Showdown only re-sends the CURRENT request, so earlier turns have no
  // available-moves data. It must be null, never guessed.
  for (const t of b.turns.slice(1, -1)) assert.strictEqual(t.available, null, `turn ${t.turn}`);
  assert.ok(b.turns[b.turns.length - 1].available, 'the final turn does have its request');
});

// ---------------------------------------------------------------------------
// Part 2: small hand-made logs
// ---------------------------------------------------------------------------

const HEADER = [
  '|init|battle', '|gametype|singles', '|player|p1|Alice|1|1000', '|player|p2|Bob|2|1000',
  '|gen|9', '|tier|[Gen 9] Random Battle', '|start',
  '|switch|p1a: Aaa|Aaa, L80|100/100', '|switch|p2a: Bbb|Bbb, L80|100/100',
];

test('spectated log (no |request|): me is null, HP stays a percentage', () => {
  const b = buildBattle([...HEADER, '|turn|1', '|move|p1a: Aaa|Tackle|p2a: Bbb', '|-damage|p2a: Bbb|70/100']);
  assert.strictEqual(b.me, null);
  assert.strictEqual(b.turns[1].moves[0].damagePct, 30);
  assert.strictEqual(b.turns[1].end.p2.hpKind, 'percent');
  assert.strictEqual(b.turns[1].available, null);
});

test('damage with [from] is indirect and is not blamed on the last move', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1',
    '|move|p1a: Aaa|Tackle|p2a: Bbb', '|-damage|p2a: Bbb|90/100',
    '|-damage|p1a: Aaa|88/100|[from] item: Life Orb',
    '|-damage|p2a: Bbb|82/100|[from] psn',
  ]);
  const m = b.turns[1].moves[0];
  assert.strictEqual(m.damagePct, 10); // only the first -damage, not Life Orb or poison
  assert.strictEqual(m.hits, 1);
  const indirect = b.turns[1].events.filter((e) => e.type === 'damage' && e.indirect);
  assert.deepStrictEqual(indirect.map((e) => e.source), ['item: Life Orb', 'psn']);
});

test('multi-hit moves add up and keep the first HP value', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1', '|move|p1a: Aaa|Bullet Seed|p2a: Bbb',
    '|-damage|p2a: Bbb|90/100', '|-damage|p2a: Bbb|80/100', '|-damage|p2a: Bbb|70/100',
  ]);
  const m = b.turns[1].moves[0];
  assert.strictEqual(m.hpBefore, 100);
  assert.strictEqual(m.hpAfter, 70);
  assert.strictEqual(m.damagePct, 30);
  assert.strictEqual(m.hits, 3);
});

test('effect lines attach to the move that just ran, and stop at the next switch/upkeep', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1',
    '|move|p1a: Aaa|Flamethrower|p2a: Bbb', '|-supereffective|p2a: Bbb', '|-damage|p2a: Bbb|0 fnt', '|-crit|p2a: Bbb', '|faint|p2a: Bbb',
    '|-supereffective|p2a: Bbb', // stray line after the faint: must not attach to anything
  ]);
  const m = b.turns[1].moves[0];
  assert.strictEqual(m.effectiveness, 'super');
  assert.strictEqual(m.crit, true);
  assert.strictEqual(m.knockedOut, true);
  assert.strictEqual(b.turns[1].faints.length, 1);
  assert.strictEqual(b.turns[1].end.p2.fainted, true);
});

test('moves called by another move do not count as revealed', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1',
    '|move|p2a: Bbb|Sleep Talk|p2a: Bbb', '|move|p2a: Bbb|Earthquake|p1a: Aaa|[from]Sleep Talk',
  ]);
  assert.deepStrictEqual(b.turns[1].end.p2.revealedMoves, ['Sleep Talk']);
  assert.strictEqual(b.turns[1].moves[1].source, 'Sleep Talk');
});

test('forceSwitch request after a faint is recorded as forceSwitch, not as available moves', () => {
  const request = {
    forceSwitch: [true],
    side: { name: 'Bob', id: 'p2', pokemon: [
      { ident: 'p2: Bbb', details: 'Bbb, L80', condition: '0 fnt', active: true, moves: ['tackle'] },
      { ident: 'p2: Ccc', details: 'Ccc, L77', condition: '200/200', active: false, moves: ['tackle'] },
    ] },
  };
  const b = buildBattle([
    ...HEADER, '|turn|1', '|move|p1a: Aaa|Tackle|p2a: Bbb', '|-damage|p2a: Bbb|0 fnt', '|faint|p2a: Bbb',
    `|request|${JSON.stringify(request)}`, '|switch|p2a: Ccc|Ccc, L77|200/200',
  ]);
  const t = b.turns[1];
  assert.strictEqual(b.me, 'p2');
  assert.strictEqual(t.available, null);
  assert.deepStrictEqual(t.forceSwitch.switchOptions.map((o) => o.name), ['Ccc']);
  assert.deepStrictEqual(t.switches.map((s) => [s.mon, s.from]), [['Ccc', 'Bbb']]);
});

test('unknown commands are counted, never thrown; unknown "-" effects are kept as events', () => {
  const b = buildBattle([...HEADER, '|turn|1', '|somethingnew|x|y', '|-weirdeffect|p1a: Aaa|z']);
  assert.deepStrictEqual(b.warnings.unknownCommands, { somethingnew: 1 });
  assert.ok(b.turns[1].events.some((e) => e.type === 'weirdeffect'));
});

test('Tera in switch details marks the Pokémon as already Terastallized', () => {
  const b = buildBattle([...HEADER, '|turn|1', '|switch|p1a: Aaa|Aaa, L80, tera:Fire|100/100']);
  assert.strictEqual(b.turns[1].end.p1.terastallized, true);
  assert.strictEqual(b.turns[1].end.p1.teraType, 'Fire');
});

test('typechange is recorded and cleared when the Pokémon switches out', () => {
  const b = buildBattle([
    ...HEADER, '|turn|1', '|-start|p1a: Aaa|typechange|Fire',
    '|turn|2', '|switch|p1a: Zzz|Zzz, L80|100/100',
  ]);
  assert.deepStrictEqual(b.turns[1].end.p1.typeOverride, ['Fire']);
  assert.strictEqual(b.turns[2].end.p1.name, 'Zzz');
  // Aaa is no longer active, but its record must be clean if it comes back.
  assert.strictEqual(b.turns[2].end.p1.typeOverride, null);
});
