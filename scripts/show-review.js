// scripts/show-review.js: print the review of a saved battle log, to check each flagged
// moment against what you remember of the game.
// Usage: npm run show-review -- test-data/<file>.log [--options]
//   --options  also list, for every turn the move-choice rules could judge, each move you had
//              available and its estimated damage to the opponent (so you can see why a turn
//              was or was not flagged).
// Not part of the app.

const fs = require('fs');
const path = require('path');
const { buildBattle } = require('../src/core/state');
const { buildReview, describeMoveChoices } = require('../src/core/review');

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run show-review -- <path to a .log file> [--options]');
  process.exit(1);
}

const battle = buildBattle(fs.readFileSync(file, 'utf8').split(/\r?\n/));
const review = buildReview(battle, { room: path.basename(file, '.log') });

console.log(`${review.players.me} vs ${review.players.opponent}: ${review.result.won === null ? 'no result' : review.result.won ? 'won' : 'lost'}${review.result.forfeit ? ' (forfeit)' : ''}, ${review.result.lastTurn} turns`);
console.log(review.moments.length ? `\n${review.moments.length} moment(s):` : '\nNo moments flagged.');
for (const m of review.moments) {
  console.log(`\nTurn ${m.turn}  [${m.label.toUpperCase()}]  ${m.rule}  (${m.mon})`);
  console.log(`   ${m.title}`);
  console.log(`   ${m.facts.whyKnowable}`);
}

if (process.argv.includes('--options')) {
  const rows = describeMoveChoices(battle);
  console.log(`\nMove choices the rules could judge: ${rows.length}`);
  for (const r of rows) {
    console.log(`\nTurn ${r.turn}: vs ${r.oppMon} at ${r.oppHpPct}% HP${r.knockedOut ? ' (you knocked it out)' : ''}`);
    for (const o of r.options) {
      const ko = o.guaranteedKo ? 'sure KO' : o.possibleKo ? 'maybe KO' : '';
      console.log(`   ${o.name === r.chosen ? '*' : ' '} ${o.name.padEnd(18)} ${String(o.minPct).padStart(5)}-${String(o.maxPct).padEnd(5)}% ${ko}${o.abilitiesTried.length > 1 ? `  (abilities: ${o.abilitiesTried.join('/')})` : ''}`);
    }
  }
}
