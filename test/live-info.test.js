// Tests for the live-info stub: it only has to prove the wiring and the line count.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildLiveInfo } = require('../src/core/live-info');

const DIR = path.join(__dirname, '..', 'test-data');

test('buildLiveInfo on a real log reports how many lines it was given', () => {
  const file = fs.readdirSync(DIR).find((f) => f.endsWith('.log'));
  const text = fs.readFileSync(path.join(DIR, file), 'utf8');
  const lines = text.split('\n');
  // Counted from the raw text (newlines + 1), not from lines.length, so the test is not
  // just repeating the function's own logic.
  const expected = (text.match(/\n/g) || []).length + 1;
  assert.deepStrictEqual(buildLiveInfo(lines), { linesSeen: expected });
});

test('buildLiveInfo on no lines reports 0', () => {
  assert.deepStrictEqual(buildLiveInfo([]), { linesSeen: 0 });
});
