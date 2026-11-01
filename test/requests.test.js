// Tests for requests.js: putting earlier |request| lines back into a replayed log.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { restoreRequests } = require('../src/core/requests');
const { buildBattle } = require('../src/core/state');

const active = (id) => `|request|${JSON.stringify({ active: [{ moves: [] }], side: { id: 'p2', pokemon: [] }, rqid: id })}`;
const force = (id) => `|request|${JSON.stringify({ forceSwitch: [true], side: { id: 'p2', pokemon: [] }, rqid: id })}`;
const wait = (id) => `|request|${JSON.stringify({ wait: true, side: { id: 'p2', pokemon: [] }, rqid: id })}`;

// What we captured live: requests after each |turn|, a forced switch at the end of turn 2.
const OLD = [
  '|init|battle', '|start', '|turn|1', active(1), '|move|x', '|upkeep',
  '|turn|2', active(2), '|move|y', '|faint|y', '|upkeep', force(3), '|switch|z', wait(4),
  '|turn|3', active(5), '|move|w',
];

// What Showdown replays after a reload: same history, no old requests, only the current one.
const REPLAY = [
  '|init|battle', '|start', '|turn|1', '|move|x', '|upkeep',
  '|turn|2', '|move|y', '|faint|y', '|upkeep', '|switch|z',
  '|turn|3', '|move|w', active(99), // current request, different rqid than the saved one
];

test('active requests return after their |turn|, forceSwitch at the end of its turn, wait is dropped', () => {
  const out = restoreRequests(REPLAY, OLD);
  assert.deepStrictEqual(out, [
    '|init|battle', '|start',
    '|turn|1', active(1), '|move|x', '|upkeep',
    '|turn|2', active(2), '|move|y', '|faint|y', '|upkeep', '|switch|z',
    force(3), // just before |turn|3
    '|turn|3', '|move|w', active(99),
  ]);
});

test('the live request wins: no second copy for a turn that already has one', () => {
  const out = restoreRequests(REPLAY, OLD);
  const turn3 = out.slice(out.indexOf('|turn|3'));
  assert.strictEqual(turn3.filter((l) => l.startsWith('|request|')).length, 1);
  assert.ok(turn3.includes(active(99)));
  assert.ok(!out.includes(active(5)));
});

test('running it again changes nothing (reloads do not pile up copies)', () => {
  const once = restoreRequests(REPLAY, OLD);
  const twice = restoreRequests(once, OLD);
  assert.deepStrictEqual(twice, once);
  // ...and a second reload, whose "old file" is the first result:
  assert.deepStrictEqual(restoreRequests(REPLAY, once), once);
});

test('latest request of a kind wins when the old file has several in one turn', () => {
  const old = ['|init|battle', '|turn|1', active(1), '|error|[Unavailable choice]', active(2)];
  const out = restoreRequests(['|init|battle', '|turn|1'], old);
  assert.deepStrictEqual(out, ['|init|battle', '|turn|1', active(2)]);
});

test('forceSwitch in the last turn of the replay goes at the very end', () => {
  const old = ['|init|battle', '|turn|1', active(1), '|faint|a', '|upkeep', force(2)];
  const out = restoreRequests(['|init|battle', '|turn|1', '|faint|a', '|upkeep'], old);
  assert.deepStrictEqual(out, ['|init|battle', '|turn|1', active(1), '|faint|a', '|upkeep', force(2)]);
});

test('no old file or no old requests: the replay comes back unchanged', () => {
  assert.deepStrictEqual(restoreRequests(REPLAY, []), REPLAY);
  assert.deepStrictEqual(restoreRequests(REPLAY, ['|init|battle', '|turn|1', '|move|x']), REPLAY);
});

test('damaged request lines and requests before |turn|1 are ignored', () => {
  const old = ['|init|battle', active(1), '|turn|1', '|request|{"active":', '|move|x'];
  assert.deepStrictEqual(restoreRequests(['|init|battle', '|turn|1'], old), ['|init|battle', '|turn|1']);
});

test('real log round trip: every turn gets its available moves and forced switches back', () => {
  const file = path.join(__dirname, '..', 'test-data', 'battle-gen9randombattle-2707357132.log');
  const original = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
  const requestIdx = original.map((l, i) => (l.startsWith('|request|') ? i : -1)).filter((i) => i >= 0);
  assert.ok(requestIdx.length > 10);

  // Simulate the replay: drop every request except the last (the "current" one).
  const keep = requestIdx[requestIdx.length - 1];
  const replay = original.filter((l, i) => !l.startsWith('|request|') || i === keep);

  const restored = restoreRequests(replay, original);
  const a = buildBattle(original);
  const b = buildBattle(restored);

  assert.strictEqual(b.me, a.me);
  assert.deepStrictEqual(b.turns.map((t) => t.available), a.turns.map((t) => t.available));
  assert.deepStrictEqual(b.turns.map((t) => t.forceSwitch), a.turns.map((t) => t.forceSwitch));
  // And the replay on its own really was missing them, so this test proves something.
  const bare = buildBattle(replay);
  assert.ok(bare.turns.filter((t) => t.turn > 0 && t.available === null).length >= 5);
});
