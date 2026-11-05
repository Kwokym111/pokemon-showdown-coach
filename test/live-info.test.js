// Tests for the live panel's pure core, on real (anonymised) battle logs in test-data/.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildLiveInfo } = require('../src/core/live-info');
const { buildBattle } = require('../src/core/state');
const { currentTypes, typeChart } = require('../src/core/data');

const DIR = path.join(__dirname, '..', 'test-data');
const readLines = (file) => fs.readFileSync(path.join(DIR, file), 'utf8').split('\n');

// Logs where the OPPONENT Terastallizes: at turn 22 (me = p1) and turn 2 (me = p2).
const TERA_LOG_LATE = 'battle-gen9randombattle-2707352165-ghpcomhxs9xljqkvhxs3ufwfmwhjj0qpw.log';
const TERA_LOG_EARLY = 'battle-gen9randombattle-2707357132.log';
const LONG_LOG = TERA_LOG_LATE;

// Lines up to and including `|turn|N` and the `|request|` that follows it: what the app has
// seen once turn N's decision is on screen. The request has to be included because in a real
// log it comes AFTER the turn line, and in turn 1 it is the first one, which is how we learn
// which side is ours (until then buildLiveInfo correctly returns null).
function upToTurn(lines, n) {
  const idx = lines.indexOf(`|turn|${n}`);
  assert.ok(idx !== -1, `log has no |turn|${n}`);
  const withRequest = lines[idx + 1] && lines[idx + 1].startsWith('|request|') ? idx + 2 : idx + 1;
  return lines.slice(0, withRequest);
}

// The opponent's active Pokémon at the start of turn n, straight from the state (not from
// live-info), so the tests do not just repeat the function under test.
function oppAt(lines, n) {
  const battle = buildBattle(upToTurn(lines, n));
  const turn = battle.turns.find((t) => t.turn === n);
  return { battle, mon: turn.start[battle.me === 'p1' ? 'p2' : 'p1'] };
}

test('mid-battle: opponent species, types and matchups agree with the data layer', () => {
  const lines = readLines(LONG_LOG);
  const info = buildLiveInfo(upToTurn(lines, 10));
  const { battle, mon } = oppAt(lines, 10);

  assert.strictEqual(info.turn, 10);
  assert.strictEqual(info.ended, false);
  assert.strictEqual(info.opponent.species, mon.species);
  assert.deepStrictEqual(info.opponent.types, currentTypes(battle.gen, mon));

  const chart = typeChart(battle.gen, info.opponent.types);
  assert.ok(info.opponent.weak.every((w) => w.x >= 2 && chart[w.type] === w.x));
  assert.ok(info.opponent.resist.every((r) => r.x > 0 && r.x < 1 && chart[r.type] === r.x));
  assert.ok(info.opponent.immune.every((t) => chart[t] === 0));
  // Nothing is lost: every non-neutral type in the chart appears in exactly one list.
  const listed = info.opponent.weak.length + info.opponent.resist.length + info.opponent.immune.length;
  assert.strictEqual(listed, Object.values(chart).filter((x) => x !== 1).length);
  assert.ok(info.me && info.me.types.length > 0);
});

test('lists are sorted strongest first, then by type name', () => {
  const lines = readLines(LONG_LOG);
  for (const n of [1, 5, 10, 20]) {
    const info = buildLiveInfo(upToTurn(lines, n));
    for (const side of [info.opponent, info.me]) {
      for (let i = 1; i < side.weak.length; i++) {
        const a = side.weak[i - 1], b = side.weak[i];
        assert.ok(a.x > b.x || (a.x === b.x && a.type < b.type), 'weak order');
      }
      for (let i = 1; i < side.resist.length; i++) {
        const a = side.resist[i - 1], b = side.resist[i];
        assert.ok(a.x < b.x || (a.x === b.x && a.type < b.type), 'resist order');
      }
    }
  }
});

for (const [file, teraTurn] of [[TERA_LOG_LATE, 22], [TERA_LOG_EARLY, 2]]) {
  test(`opponent Tera (${teraTurn}): hidden before it happens, single Tera type after`, () => {
    const lines = readLines(file);
    const full = buildBattle(lines);
    const oppSide = full.me === 'p1' ? 'p2' : 'p1';
    // First turn whose START already shows the opponent Terastallized.
    const after = full.turns.find((t) => t.start && t.start[oppSide] && t.start[oppSide].terastallized);
    assert.ok(after, 'test log should contain an opponent Tera');
    const teraType = after.start[oppSide].teraType;

    const post = buildLiveInfo(upToTurn(lines, after.turn)).opponent;
    assert.strictEqual(post.terastallized, true);
    assert.deepStrictEqual(post.types, [teraType]);

    // The turn before: still its normal types. The Tera type is not exposed in any field.
    const before = buildLiveInfo(upToTurn(lines, after.turn - 1)).opponent;
    const { battle, mon } = oppAt(lines, after.turn - 1);
    assert.strictEqual(before.terastallized, false);
    assert.deepStrictEqual(before.types, currentTypes(battle.gen, mon));
    for (const key of ['teraType', 'plannedTera', 'tera']) assert.ok(!(key in before), `no ${key} key`);
  });
}

test('compliance: the opponent object only has whitelisted keys and no unrevealed moves', () => {
  const ALLOWED = ['name', 'species', 'types', 'terastallized', 'hpPct', 'status', 'weak', 'resist', 'immune', 'revealedMoves'];
  for (const file of fs.readdirSync(DIR).filter((f) => f.startsWith('battle-gen9') && f.endsWith('.log'))) {
    const lines = readLines(file);
    const full = buildBattle(lines);
    const oppSide = full.me === 'p1' ? 'p2' : 'p1';
    const turns = full.turns.filter((t) => t.start).map((t) => t.turn);

    for (const n of turns) {
      const cut = upToTurn(lines, n);
      const info = buildLiveInfo(cut);
      if (!info || !info.opponent) continue;
      assert.ok(Object.keys(info.opponent).every((k) => ALLOWED.includes(k)), `${file} turn ${n}: extra key`);

      // Moves this Pokémon only uses LATER in the log must not be present yet.
      const shown = new Set(info.opponent.revealedMoves.map((m) => m.name));
      const lateMon = full.turns[full.turns.length - 1].end[oppSide];
      const laterMoves = new Set();
      for (const t of full.turns) {
        const m = t.end && t.end[oppSide];
        if (m && m.species === info.opponent.species) m.revealedMoves.forEach((x) => laterMoves.add(x));
      }
      assert.ok(lateMon);
      const json = JSON.stringify(info.opponent);
      for (const move of laterMoves) {
        if (!shown.has(move)) assert.ok(!json.includes(`"${move}"`), `${file} turn ${n}: ${move} leaked early`);
      }
    }
  }
});

test('revealedMoves only lists moves already used, with type and category', () => {
  const lines = readLines(LONG_LOG);
  const info = buildLiveInfo(upToTurn(lines, 23));
  assert.deepStrictEqual(info.opponent.revealedMoves.map((m) => m.name), ['Stun Spore', 'Protect', 'Knock Off']);
  assert.deepStrictEqual(info.opponent.revealedMoves[2], { name: 'Knock Off', type: 'Dark', category: 'Physical' });
});

test('returns null when there is nothing to show', () => {
  assert.strictEqual(buildLiveInfo([]), null);

  const lines = readLines(LONG_LOG);
  // No |request| at all (what a spectator sees): drop them.
  const noRequest = upToTurn(lines, 5).filter((l) => !l.startsWith('|request|'));
  assert.strictEqual(buildLiveInfo(noRequest), null);

  // Before the first |turn|: the header and lead-in switches only.
  const firstTurn = lines.indexOf('|turn|1');
  assert.strictEqual(buildLiveInfo(lines.slice(0, firstTurn)), null);
});

test('ended battles keep their last state and say so', () => {
  const lines = readLines(LONG_LOG);
  const info = buildLiveInfo(lines);
  assert.strictEqual(info.ended, true);
  assert.ok(info.turn >= 1);
});

test('never throws on a log cut at every 50th line', () => {
  const lines = readLines(LONG_LOG);
  for (let k = 0; k <= lines.length; k += 50) {
    const info = buildLiveInfo(lines.slice(0, k));
    assert.ok(info === null || typeof info === 'object');
    // Only plain data may cross IPC.
    if (info) assert.deepStrictEqual(JSON.parse(JSON.stringify(info)), info);
  }
});
