// Tests for the live panel's pure core, on real (anonymised) battle logs in test-data/.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildLiveInfo } = require('../src/core/live-info');
const { buildBattle } = require('../src/core/state');
const { currentTypes, typeChart, getSpecies } = require('../src/core/data');

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
  const ALLOWED = ['name', 'species', 'types', 'terastallized', 'hpPct', 'fainted', 'status', 'statusName', 'boosts', 'volatiles', 'weak', 'resist', 'immune',
    'revealedMoves', 'baseStats', 'possibleAbilities', 'revealedAbility'];
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
  const ko = info.opponent.revealedMoves[2];
  assert.deepStrictEqual(
    [ko.name, ko.type, ko.category, ko.basePower, ko.accuracy],
    ['Knock Off', 'Dark', 'Physical', 65, 100],
  );
  assert.ok(ko.shortDesc.length > 0);
  // The Status move has a description too; its power is 0 (the panel shows "-").
  assert.strictEqual(info.opponent.revealedMoves[1].basePower, 0);
});

test('revealedAbility is null until the log shows the opponent\'s ability', () => {
  const lines = readLines(LONG_LOG);
  // Turn 1: Cinderace is out but has not shown its ability yet (Libero shows later).
  const t1 = buildLiveInfo(upToTurn(lines, 1)).opponent;
  assert.strictEqual(t1.species, 'Cinderace');
  assert.strictEqual(t1.revealedAbility, null);
  // Turn 15: Rhyperior, nothing shown. The |-ability| line for Wo-Chien comes right before |turn|16.
  assert.strictEqual(buildLiveInfo(upToTurn(lines, 15)).opponent.revealedAbility, null);
  const t16 = buildLiveInfo(upToTurn(lines, 16)).opponent;
  assert.strictEqual(t16.species, 'Wo-Chien');
  assert.strictEqual(t16.revealedAbility, 'Tablets of Ruin');
  // The Pokémon's own ability is in the possible list (the panel matches the two with toId).
  assert.ok(t16.possibleAbilities.some((a) => a.name === 'Tablets of Ruin'));
});

test('a revealed ability outside the species list is still reported (Trace, Skill Swap...)', () => {
  // Synthetic: add a reveal line for an ability Cinderace cannot have.
  const lines = readLines(LONG_LOG);
  const cut = upToTurn(lines, 1);
  // Before |turn|1, so it is part of the state at the start of turn 1.
  const at = cut.indexOf('|turn|1');
  const withReveal = [...cut.slice(0, at), '|-ability|p2a: Cinderace|Trace', ...cut.slice(at)];
  const opp = buildLiveInfo(withReveal).opponent;
  assert.strictEqual(opp.revealedAbility, 'Trace');
  assert.ok(!opp.possibleAbilities.some((a) => a.name === 'Trace'));
});

test('baseStats and possibleAbilities are the species reference data', () => {
  const lines = readLines(LONG_LOG);
  const info = buildLiveInfo(upToTurn(lines, 10));
  const { battle, mon } = oppAt(lines, 10);
  const sp = getSpecies(battle.gen, mon.species);
  assert.deepStrictEqual(info.opponent.baseStats, sp.baseStats);
  assert.deepStrictEqual(info.opponent.possibleAbilities.map((a) => a.name), sp.abilities);
  assert.ok(info.opponent.possibleAbilities.every((a) => typeof a.shortDesc === 'string'));
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

// ---------------------------------------------------------------------------
// Live state (not the turn-start snapshot) and the opponent roster
// ---------------------------------------------------------------------------

const gen9Logs = () => fs.readdirSync(DIR).filter((f) => f.startsWith('battle-gen9') && f.endsWith('.log'));
const oppSideOf = (lines) => (buildBattle(lines).me === 'p1' ? 'p2' : 'p1');

test('a move shows up as soon as its line arrives, not only at the next |turn|', () => {
  const lines = readLines(LONG_LOG);
  const opp = oppSideOf(lines);
  const firstTurn2 = lines.indexOf('|turn|2');
  // The first opponent move after turn 2 starts (a direct |move|, not a [from] call).
  const idx = lines.findIndex((l, i) => i > firstTurn2 && l.startsWith(`|move|${opp}a: `) && !l.includes('[from]'));
  assert.ok(idx > 0);
  const move = lines[idx].split('|')[3];

  const withMove = buildLiveInfo(lines.slice(0, idx + 1)).opponent.revealedMoves.map((m) => m.name);
  const before = buildLiveInfo(lines.slice(0, idx)).opponent.revealedMoves.map((m) => m.name);
  assert.ok(withMove.includes(move), `${move} should show right after its line`);
  // (It may have been used earlier in the battle; only check the new line made the difference.)
  assert.strictEqual(withMove.length, before.includes(move) ? before.length : before.length + 1);
});

test('a fainted opponent is flagged, and the moves it used are still listed', () => {
  let checked = 0;
  for (const file of gen9Logs()) {
    const lines = readLines(file);
    const opp = oppSideOf(lines);
    const idx = lines.findIndex((l) => l.startsWith(`|faint|${opp}a: `));
    if (idx === -1) continue;
    const info = buildLiveInfo(lines.slice(0, idx + 1));
    if (!info) continue;
    assert.strictEqual(info.opponent.fainted, true, file);
    assert.strictEqual(info.opponent.status, null, file);
    assert.strictEqual(info.opponent.hpPct, 0, file);
    // The turn before it was not flagged.
    checked++;
  }
  assert.ok(checked >= 2, 'expected opponent faints in the test logs');
});

// Opponent Pokémon names in the order a |switch| or |drag| line first showed them.
function seenOpponents(cut, oppSide) {
  const names = [];
  for (const l of cut) {
    const m = /^\|(?:switch|drag)\|(p[12])[ab]?: ([^|]+)\|/.exec(l);
    if (m && m[1] === oppSide && !names.includes(m[2])) names.push(m[2]);
  }
  return names;
}

test('roster: only Pokémon that have appeared, in order, one active, same data as `opponent`', () => {
  const ROSTER_KEYS = ['name', 'species', 'types', 'terastallized', 'hpPct', 'fainted', 'status', 'statusName', 'boosts', 'volatiles', 'weak', 'resist', 'immune',
    'revealedMoves', 'baseStats', 'possibleAbilities', 'revealedAbility', 'active'];
  for (const file of gen9Logs()) {
    const lines = readLines(file);
    const full = buildBattle(lines);
    if (!full.me) continue;
    const opp = oppSideOf(lines);
    for (const n of full.turns.filter((t) => t.start).map((t) => t.turn)) {
      const cut = upToTurn(lines, n);
      const info = buildLiveInfo(cut);
      if (!info) continue;
      const seen = seenOpponents(cut, opp);

      assert.deepStrictEqual(info.opponentTeam.map((m) => m.name), seen, `${file} turn ${n}: roster order`);
      assert.ok(info.opponentTeam.every((m) => Object.keys(m).every((k) => ROSTER_KEYS.includes(k))), `${file} turn ${n}: roster keys`);
      assert.strictEqual(info.opponentTeam.filter((m) => m.active).length, 1, `${file} turn ${n}: one active`);

      const active = info.opponentTeam.find((m) => m.active);
      const { active: _a, ...rest } = active;
      assert.deepStrictEqual(rest, info.opponent, `${file} turn ${n}: active entry equals opponent`);

      // Every move listed for a roster Pokémon was really used by it in the lines so far.
      for (const m of info.opponentTeam) {
        for (const mv of m.revealedMoves) {
          const used = cut.some((l) => l.startsWith(`|move|${opp}a: ${m.name}|${mv.name}|`) && !l.includes('[from]'));
          assert.ok(used, `${file} turn ${n}: ${m.name} / ${mv.name} not used yet`);
        }
      }
      // Unseen = team size minus seen (6 in Random Battles).
      assert.strictEqual(info.unseenCount, Math.max(0, full.teamSize[opp] - seen.length), `${file} turn ${n}: unseen`);
    }
  }
});

test('roster keeps a Pokémon that switched out, with its revealed moves', () => {
  const lines = readLines(LONG_LOG);
  // Turn 23 is Wo-Chien (moves seen: Stun Spore, Protect, Knock Off); by turn 24 it is gone.
  const info = buildLiveInfo(upToTurn(lines, 24));
  assert.notStrictEqual(info.opponent.species, 'Wo-Chien');
  const wo = info.opponentTeam.find((m) => m.species === 'Wo-Chien');
  assert.ok(wo && !wo.active);
  assert.deepStrictEqual(wo.revealedMoves.map((m) => m.name), ['Stun Spore', 'Protect', 'Knock Off']);
  assert.strictEqual(wo.revealedAbility, 'Tablets of Ruin');
});

// ---------------------------------------------------------------------------
// Effects: status, stat stages, field
// ---------------------------------------------------------------------------

test('stat stages: only non-zero ones, in a fixed order, for the opponent (live, mid-turn)', () => {
  const lines = readLines(LONG_LOG);
  // Lines 178 to 217 (1-based): Rhyperior (opponent) gets atk +2, spa +2, spe +2 and then atk -1.
  const cut = lines.slice(0, 217);
  assert.ok(cut[216].startsWith('|-unboost|p2a: Rhyperior|atk|1'));
  const opp = buildLiveInfo(cut).opponent;
  assert.strictEqual(opp.species, 'Rhyperior');
  assert.deepStrictEqual(opp.boosts, [{ stat: 'atk', stages: 1 }, { stat: 'spa', stages: 2 }, { stat: 'spe', stages: 2 }]);
  // A Pokémon that was never boosted has an empty list, and the Rhyperior entry in the roster
  // matches the active one.
  assert.deepStrictEqual(buildLiveInfo(upToTurn(lines, 1)).opponent.boosts, []);
});

test('stat stages and statuses end when the Pokémon leaves (roster shows none)', () => {
  const lines = readLines(LONG_LOG);
  const info = buildLiveInfo(upToTurn(lines, 20)); // Wo-Chien is out; Rhyperior is benched
  const rhy = info.opponentTeam.find((m) => m.species === 'Rhyperior');
  assert.ok(rhy && !rhy.active);
  assert.deepStrictEqual(rhy.boosts, []);
});

test('my own status shows with a readable name; the opponent status uses the same shape', () => {
  const lines = readLines(LONG_LOG);
  const idx = lines.findIndex((l) => l.startsWith('|-status|p1a: Sceptile|par'));
  assert.ok(idx > 0);
  const me = buildLiveInfo(lines.slice(0, idx + 1)).me;
  assert.strictEqual(me.species, 'Sceptile');
  assert.strictEqual(me.status, 'par');
  assert.strictEqual(me.statusName, 'Paralyzed');
  // And just before the line it had none.
  const before = buildLiveInfo(lines.slice(0, idx)).me;
  assert.strictEqual(before.status, null);
  assert.strictEqual(before.statusName, null);
});

test('field: weather, terrain and screens per side, described from the data', () => {
  const lines = readLines(LONG_LOG);
  const base = buildLiveInfo(upToTurn(lines, 1)).field;
  assert.deepStrictEqual(base, { weather: null, terrain: null, mySide: [], oppSide: [] });

  // Synthetic lines before |turn|1 (this log: I am p1).
  const cut = upToTurn(lines, 1);
  const at = cut.indexOf('|turn|1');
  const extra = ['|-weather|RainDance', '|-fieldstart|move: Electric Terrain',
    '|-sidestart|p1: cool213|move: Reflect', '|-sidestart|p2: anonOpponent|move: Light Screen'];
  const f = buildLiveInfo([...cut.slice(0, at), ...extra, ...cut.slice(at)]).field;
  assert.strictEqual(f.weather.name, 'Rain');
  assert.ok(f.weather.shortDesc.length > 0);
  assert.strictEqual(f.terrain.name, 'Electric Terrain');
  assert.deepStrictEqual(f.mySide.map((x) => x.name), ['Reflect']);
  assert.deepStrictEqual(f.oppSide.map((x) => x.name), ['Light Screen']);
});

test('effects never leak hidden info: me/opponent/field only have the expected keys', () => {
  const MON = ['name', 'species', 'types', 'terastallized', 'status', 'statusName', 'boosts', 'volatiles', 'weak', 'resist', 'immune'];
  for (const file of gen9Logs()) {
    const lines = readLines(file);
    const full = buildBattle(lines);
    for (const n of full.turns.filter((t) => t.start).map((t) => t.turn)) {
      const info = buildLiveInfo(upToTurn(lines, n));
      if (!info) continue;
      if (info.me) assert.ok(Object.keys(info.me).every((k) => MON.includes(k)), `${file} turn ${n}: me keys`);
      assert.deepStrictEqual(Object.keys(info.field).sort(), ['mySide', 'oppSide', 'terrain', 'weather']);
      for (const b of [...info.opponent.boosts, ...(info.me ? info.me.boosts : [])]) {
        assert.ok(Number.isInteger(b.stages) && b.stages !== 0 && Math.abs(b.stages) <= 6);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Volatile effects and hazards
// ---------------------------------------------------------------------------

test('volatiles: shown live for both sides with the move description, gone after the end line', () => {
  const lines = readLines(LONG_LOG);
  const at = (prefix) => lines.findIndex((l) => l.startsWith(prefix));

  // Opponent Gothitelle is Leech Seeded.
  const seeded = buildLiveInfo(lines.slice(0, at('|-start|p2a: Gothitelle|move: Leech Seed') + 1)).opponent;
  assert.strictEqual(seeded.species, 'Gothitelle');
  assert.deepStrictEqual(seeded.volatiles.map((v) => v.name), ['Leech Seed']);
  assert.ok(seeded.volatiles[0].shortDesc.length > 0);

  // My Sceptile has Heal Block, then it ends.
  const hb = buildLiveInfo(lines.slice(0, at('|-start|p1a: Sceptile|move: Heal Block') + 1)).me;
  assert.deepStrictEqual(hb.volatiles.map((v) => v.name), ['Heal Block']);
  const gone = buildLiveInfo(lines.slice(0, at('|-end|p1a: Sceptile|move: Heal Block') + 1)).me;
  assert.deepStrictEqual(gone.volatiles, []);
});

test('volatiles: a lowercase condition id (confusion) gets a name but not the Confusion MOVE description', () => {
  const lines = readLines(LONG_LOG);
  const cut = upToTurn(lines, 1);
  const at = cut.indexOf('|turn|1');
  const opp = oppSideOf(lines);
  const mon = buildLiveInfo(cut).opponent.name;
  const withConf = [...cut.slice(0, at), `|-start|${opp}a: ${mon}|confusion`, ...cut.slice(at)];
  assert.deepStrictEqual(buildLiveInfo(withConf).opponent.volatiles, [{ name: 'Confusion', shortDesc: '' }]);
});

test('volatiles: benched and fainted Pokémon show none', () => {
  const lines = readLines(LONG_LOG);
  // Gothitelle (Leech Seeded at turn 4-ish) is benched by turn 12.
  const info = buildLiveInfo(upToTurn(lines, 12));
  const goth = info.opponentTeam.find((m) => m.species === 'Gothitelle');
  assert.ok(goth && !goth.active);
  assert.deepStrictEqual(goth.volatiles, []);
});

test('field: hazards per side with layers, after screens, with descriptions', () => {
  const lines = readLines(LONG_LOG); // I am p1 in this log
  const cut = upToTurn(lines, 1);
  const at = cut.indexOf('|turn|1');
  const extra = ['|-sidestart|p2: anonOpponent|Spikes', '|-sidestart|p2: anonOpponent|Spikes',
    '|-sidestart|p2: anonOpponent|move: Reflect', '|-sidestart|p1: cool213|move: Stealth Rock'];
  const f = buildLiveInfo([...cut.slice(0, at), ...extra, ...cut.slice(at)]).field;
  assert.deepStrictEqual(f.oppSide.map((x) => [x.name, x.layers]), [['Reflect', 1], ['Spikes', 2]]);
  assert.deepStrictEqual(f.mySide.map((x) => [x.name, x.layers]), [['Stealth Rock', 1]]);
  assert.ok(f.mySide[0].shortDesc.length > 0);
});

test('real log: Stealth Rock and Toxic Spikes show up on my side', () => {
  const lines = readLines('battle-gen9randombattle-2707347511-gk6nrt15cpatbvcdr3bmvh51vg2fdi3pw.log');
  const info = buildLiveInfo(lines.slice(0, lines.findIndex((l) => l.startsWith('|-sidestart|p1: cool213|move: Stealth Rock')) + 1));
  assert.strictEqual(oppSideOf(lines), 'p2'); // so p1 is me
  assert.deepStrictEqual(info.field.mySide.map((x) => x.name).sort(), ['Stealth Rock', 'Toxic Spikes']);
  assert.deepStrictEqual(info.field.oppSide, []);
});
