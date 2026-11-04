// scripts/try-ai.js: runs a sample review through the real AI so you can read the result.
//
//   node scripts/try-ai.js                          (sample-review.json, or a built-in copy)
//   node scripts/try-ai.js path/to/review.json      (a saved review)
//   node scripts/try-ai.js test-data/<game>.log     (a battle log: builds the review, then explains it)
//
// Reads .env the same way the app does (GEMINI_API_KEY, or AI_API_KEY + AI_ACCOUNT_ID).
// The key is never printed.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { addExplanations } = require('../src/main/ai');
const { loadAiConfig, aiIsConfigured } = require('../src/main/ai-config');
const { buildBattle } = require('../src/core/state');
const { buildReview } = require('../src/core/review');

const root = path.join(__dirname, '..');

// Used when no sample file is found, so the script always runs. (Same content as the
// starter pack's sample-review.json: three made-up moments.)
const BUILT_IN_SAMPLE = {
  "version": 1,
  "room": "battle-gen9randombattle-0000000001",
  "players": {
    "me": "cool213",
    "opponent": "anonOpponent"
  },
  "result": {
    "won": false,
    "forfeit": false,
    "lastTurn": 21
  },
  "aiUsed": false,
  "summary": null,
  "moments": [
    {
      "turn": 3,
      "rule": "switched-into-immunity",
      "label": "great",
      "mon": "Corviknight",
      "title": "Switched into a hit it is immune to",
      "explanation": null,
      "facts": {
        "myMon": "Corviknight",
        "myTypes": [
          "Flying",
          "Steel"
        ],
        "switchedOut": "Meowscarada",
        "oppMon": "Great Tusk",
        "oppTypes": [
          "Ground",
          "Fighting"
        ],
        "oppMove": "Headlong Rush",
        "oppMoveType": "Ground",
        "multiplier": 0,
        "effectiveness": "immune",
        "damagePct": 0,
        "knowable": true,
        "whyKnowable": "Great Tusk is a Ground type and had already used Headlong Rush on turn 2"
      }
    },
    {
      "turn": 9,
      "rule": "move-into-immunity",
      "label": "mistake",
      "mon": "Garchomp",
      "title": "Used a move the target is immune to",
      "explanation": null,
      "facts": {
        "myMon": "Garchomp",
        "myMove": "Earthquake",
        "myMoveType": "Ground",
        "oppMon": "Talonflame",
        "oppTypes": [
          "Fire",
          "Flying"
        ],
        "multiplier": 0,
        "effectiveness": "immune",
        "damagePct": 0,
        "knowable": true,
        "whyKnowable": "Talonflame had been in play since turn 7 and had not Terastallized"
      }
    },
    {
      "turn": 14,
      "rule": "switched-into-super-effective",
      "label": "blunder",
      "mon": "Meowscarada",
      "title": "Switched into a super-effective hit",
      "explanation": null,
      "facts": {
        "myMon": "Meowscarada",
        "myTypes": [
          "Grass",
          "Dark"
        ],
        "switchedOut": "Kingambit",
        "oppMon": "Volcarona",
        "oppTypes": [
          "Bug",
          "Fire"
        ],
        "oppMove": "Fiery Dance",
        "oppMoveType": "Fire",
        "multiplier": 2,
        "damagePct": 100,
        "hpBefore": 100,
        "hpAfter": 0,
        "knockedOut": true,
        "knowable": true,
        "whyKnowable": "Volcarona is a Fire type and had already used Fiery Dance on turn 12"
      }
    }
  ]
};

function findSample() {
  const candidates = [
    'sample-review.json',
    'starter-pack/sample-review.json',
    'test/fixtures/sample-review.json',
    'docs/sample-review.json',
  ];
  return candidates.map((c) => path.join(root, c)).find((p) => fs.existsSync(p));
}

async function main() {
  // Same loader the app uses, so this tests exactly what the app would do.
  const config = loadAiConfig();
  if (!aiIsConfigured(config)) {
    console.error('No AI provider configured. Copy .env.example to .env and fill in GEMINI_API_KEY');
    console.error('(or AI_API_KEY + AI_ACCOUNT_ID for Cloudflare), then run:');
    console.error('  node scripts/try-ai.js');
    process.exit(1);
  }
  // Never print the key: only which provider and models.
  const models = config.provider === 'gemini' ? config.models.join(' -> ') : (config.model || 'default model');
  console.log(`Provider: ${config.provider} (${models})`);

  let review;
  let source;
  const given = process.argv[2] ? path.resolve(process.argv[2]) : findSample();
  if (given && fs.existsSync(given) && given.toLowerCase().endsWith('.log')) {
    // A raw battle log: build the review exactly like main.js does, then explain it.
    const text = fs.readFileSync(given, 'utf8');
    if (!text.includes('|request|')) {
      console.error('That log has no |request| lines (we only spectated it), so there is nothing to review.');
      process.exit(1);
    }
    review = buildReview(buildBattle(text.split(/\r?\n/)), { room: path.basename(given, '.log') });
    source = path.relative(root, given);
    if (review.moments.length === 0) {
      console.error(`${source} has 0 moments, so there is nothing for the AI to explain.`);
      process.exit(1);
    }
  } else if (given && fs.existsSync(given)) {
    review = JSON.parse(fs.readFileSync(given, 'utf8'));
    source = path.relative(root, given);
  } else if (process.argv[2]) {
    console.error(`Could not find ${process.argv[2]}`);
    process.exit(1);
  } else {
    review = structuredClone(BUILT_IN_SAMPLE);
    source = 'built-in sample (no sample-review.json found)';
  }
  console.log(`Review: ${source}  (${review.moments.length} moment(s))`);

  const started = Date.now();
  const out = await addExplanations(review, config);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (!out.aiUsed) {
    console.error(`\nThe AI was NOT used (see the [ai] warning above, ${seconds}s). The review came back unchanged.`);
    process.exit(1);
  }

  console.log(`\nDone in ${seconds}s. Answered by: ${out.aiModel || 'unknown model'}\n`);
  console.log('SUMMARY');
  console.log('  ' + out.summary + '\n');
  for (const m of out.moments) {
    console.log(`TURN ${m.turn}  [${m.label.toUpperCase()}]  ${m.mon}: ${m.title}`);
    console.log('  ' + m.explanation + '\n');
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err && err.message);
  process.exit(1);
});
