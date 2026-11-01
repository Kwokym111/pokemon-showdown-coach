// scripts/summarize.js: print a readable turn-by-turn summary of a saved battle log.
// Usage: npm run summarize -- test-data/<file>.log
// Not part of the app. It exists so you can check the parser's output against what you
// remember from the battle.

const fs = require('fs');
const { buildBattle } = require('../src/core/state');

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run summarize -- <path to a .log file>');
  process.exit(1);
}

const b = buildBattle(fs.readFileSync(file, 'utf8').split('\n'));

// "me"/"opp" when we know which side is the player, else just p1/p2.
const label = (side) => (b.me === null ? side : side === b.me ? 'me ' : 'opp');
const hp = (v) => (v === null || v === undefined ? '?' : `${v}%`);

function describe(ev) {
  const who = ev.side ? `${label(ev.side)} ${ev.mon}` : '';
  switch (ev.type) {
    case 'switch': return `${who} ${ev.from ? `switched in for ${ev.from}` : 'leads'} (${hp(ev.hpPct)})`;
    case 'drag': return `${who} was dragged in (${hp(ev.hpPct)})`;
    case 'move': {
      const bits = [];
      if (ev.missed) bits.push('MISSED');
      if (ev.failed) bits.push('FAILED');
      if (ev.effectiveness === 'immune') bits.push(`no effect${ev.immuneBy ? ` (${ev.immuneBy})` : ''}`);
      else if (ev.effectiveness === 'super') bits.push('super effective');
      else if (ev.effectiveness === 'resisted') bits.push('resisted');
      if (ev.crit) bits.push('crit');
      if (ev.hits > 0) bits.push(`-${ev.damagePct}% (${hp(ev.hpBefore)} -> ${hp(ev.hpAfter)})`);
      if (ev.knockedOut) bits.push('KO');
      return `${who} used ${ev.move}${ev.source ? ` [via ${ev.source}]` : ''}${bits.length ? `: ${bits.join(', ')}` : ''}`;
    }
    case 'damage':
      if (ev.indirect) return `${who} took damage from ${ev.source}: ${hp(ev.hpBefore)} -> ${hp(ev.hpAfter)}`;
      if (ev.self) return `${who} paid HP itself: ${hp(ev.hpBefore)} -> ${hp(ev.hpAfter)}`;
      return null; // direct damage is shown on the move line
    case 'heal': return `${who} healed${ev.source ? ` (${ev.source})` : ''}: ${hp(ev.hpBefore)} -> ${hp(ev.hpAfter)}`;
    case 'sethp': return `${who} HP set: ${hp(ev.hpBefore)} -> ${hp(ev.hpAfter)}`;
    case 'faint': return `${who} fainted`;
    case 'tera': return `${who} Terastallized into ${ev.teraType}`;
    case 'cant': return `${who} could not move (${ev.reason})`;
    case 'message': return `message: ${ev.text}`;
    // Effect lines already folded into the move line; skip them here.
    case 'supereffective': case 'resisted': case 'immune': case 'crit': case 'miss': case 'fail': return null;
    default: return `(${ev.type}${ev.args ? ` ${ev.args.join(' | ')}` : ''})`;
  }
}

const p = b.players;
console.log(`Gen ${b.gen} | ${b.format} | ${b.gameType} | ${b.rated ? 'rated' : 'unrated'}`);
console.log(`${p.p1 && p.p1.name} (p1${b.me === 'p1' ? ', me' : ''}) vs ${p.p2 && p.p2.name} (p2${b.me === 'p2' ? ', me' : ''})`);

for (const t of b.turns) {
  console.log(`\nTurn ${t.turn}${t.turn === 0 ? ' (leads)' : ''}`);
  if (t.available) {
    const tera = t.available.canTerastallize ? ` | can Terastallize (${t.available.canTerastallize})` : '';
    console.log(`   my options: ${t.available.moves.map((m) => m.name + (m.disabled ? ' (disabled)' : '')).join(', ')}${tera}`);
  } else if (t.turn > 0 && b.me) {
    console.log('   my options: not captured for this turn');
  }
  for (const ev of t.events) {
    const text = describe(ev);
    if (text) console.log(`   ${text}`);
  }
  if (t.forceSwitch) console.log(`   (I had to choose a replacement from: ${t.forceSwitch.switchOptions.map((o) => o.name).join(', ')})`);
}

const r = b.result;
console.log('\nResult:');
if (r.winner) console.log(`   ${r.winner} won${r.forfeit ? ` (${r.forfeiter} forfeited)` : r.inactive ? ' (opponent timed out)' : ''}`);
else console.log('   no winner recorded (battle not finished in this log)');
const unknown = Object.keys(b.warnings.unknownCommands);
if (unknown.length) console.log(`   unknown commands: ${unknown.join(', ')}`);
