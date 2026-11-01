// Tests for logs.js: the "start the file fresh on |init|battle" rule.
// Uses a temp folder, never the real battle-logs folder.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initLogs, writeLines } = require('../src/main/logs');

const readLog = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter((l) => l !== '');

// initLogs creates <given folder>/battle-logs and returns that path.
function newDir() {
  return initLogs(fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-coach-')));
}

// repeat_refresh.log is one battle that was reloaded 4 times, so it holds 5 copies of the
// history back to back. Split it into the 5 messages Showdown would have sent.
function replayChunks() {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'test-data', 'repeat_refresh.log'), 'utf8')
    .split('\n').filter((l) => l !== '');
  const chunks = [];
  for (const line of lines) {
    if (line === '|init|battle') chunks.push([]);
    chunks[chunks.length - 1].push(line);
  }
  return chunks;
}

test('replayed history leaves one clean copy of the battle', () => {
  const dir = newDir();
  const chunks = replayChunks();
  assert.strictEqual(chunks.length, 5);

  for (const chunk of chunks) writeLines('battle-gen9randombattle-1', chunk);

  const log = readLog(dir, 'battle-gen9randombattle-1.log');
  assert.strictEqual(log.filter((l) => l === '|init|battle').length, 1);
  assert.deepStrictEqual(log, chunks[chunks.length - 1]);
  // The battle's own ending (|win|, then |deinit) must survive the resets.
  assert.ok(log.includes('|win|cool213'));
  assert.strictEqual(log[log.length - 1], '|deinit');
});

test('lines without |init|battle are appended', () => {
  const dir = newDir();
  writeLines('battle-x', ['|init|battle', '|turn|1']);
  const { fresh } = writeLines('battle-x', ['|turn|2']);

  assert.strictEqual(fresh, false);
  assert.deepStrictEqual(readLog(dir, 'battle-x.log'), ['|init|battle', '|turn|1', '|turn|2']);
});

test('fresh is true only when the write contains |init|battle', () => {
  newDir();
  assert.strictEqual(writeLines('battle-y', ['|init|battle', '|turn|1']).fresh, true);
  assert.strictEqual(writeLines('battle-y', ['|turn|2']).fresh, false);
});

test('a hostile room id cannot write outside the log folder', () => {
  const dir = newDir();
  writeLines('battle-../../evil', ['|turn|1']);
  assert.ok(fs.readdirSync(dir).includes('battle-______evil.log'));
});
