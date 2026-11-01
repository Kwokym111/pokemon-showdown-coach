// scripts/check-damage.js: how close are damage.js estimates to what really happened?
// Usage: npm run check-damage [-- <extra folder of .log files>]
// Always reads test-data/. Pass a folder (e.g. the live battle-logs folder) to add more.
// Not part of the app. It measures how good the numbers are that the damage-based review
// rules will rely on.
//
// For every damaging hit by either side it compares the log's real damage (% of max HP)
// with the estimate's minPct-maxPct. The estimate uses what state.js tracks at the START of
// the turn (turn.field, and the boosts on the turn.start Pokémon), which is also what a
// player could see when choosing. See usable() for which hits are comparable.

const fs = require('fs');
const path = require('path');
const { buildBattle } = require('../src/core/state');
const { parseIdent } = require('../src/core/parser');
const { estimateDamage } = require('../src/core/damage');

const TOLERANCE = 1; // the opponent's HP in the log is rounded to a whole percent
const NEAR = 5; // the "close enough" band for the second headline number

const folders = [path.join(__dirname, '..', 'test-data')];
if (process.argv[2]) folders.push(path.resolve(process.argv[2]));

// ---------------------------------------------------------------------------
// Load logs, skipping exact duplicates (test-data has copies of the same battle)
// ---------------------------------------------------------------------------

function signature(lines) {
  return lines.filter((l) => l.startsWith('|move|') || l.startsWith('|-damage|')).join('\n');
}

const battles = [];
const seen = new Set();
let duplicates = 0;
for (const dir of folders) {
  if (!fs.existsSync(dir)) { console.error(`folder not found: ${dir}`); process.exit(1); }
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort()) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/);
    const sig = signature(lines);
    if (!sig || seen.has(sig)) { if (sig) duplicates++; continue; }
    seen.add(sig);
    battles.push({ file, battle: buildBattle(lines) });
  }
}

// ---------------------------------------------------------------------------
// Which hits can be compared fairly
// ---------------------------------------------------------------------------

function usable(ev, start) {
  if (!ev.target || ev.target.side === ev.side) return false; // self-targeting
  if (ev.crit || ev.knockedOut || ev.hits !== 1 || ev.source || ev.missed) return false;
  if (!(ev.damagePct > 0)) return false;
  const a = start[ev.side];
  const d = start[ev.target.side];
  // Mid-turn switch-ins are not in turn.start, so the estimate would use the wrong Pokémon.
  return !!a && !!d && a.name === ev.mon && d.name === ev.target.mon;
}

const BOOST_EVENTS = new Set(['boost', 'unboost', 'setboost', 'clearboost', 'clearpositiveboost',
  'clearnegativeboost', 'clearallboost', 'invertboost', 'swapboost', 'copyboost']);
const SCREEN = /Reflect|Light Screen|Aurora Veil/;

// Did something the estimate models change EARLIER IN THIS TURN, before the move? Then the
// start-of-turn state is wrong for this hit and it cannot be judged fairly.
function changedBeforeMove(turn, ev) {
  const mons = new Set([`${ev.side}|${ev.mon}`, `${ev.target.side}|${ev.target.mon}`]);
  return turn.events.some((e) => {
    if (e.seq >= ev.seq) return false;
    const a = e.args || [];
    if (BOOST_EVENTS.has(e.type)) {
      return a.slice(0, e.type === 'swapboost' || e.type === 'copyboost' ? 2 : 1).some((id) => {
        const p = parseIdent(id);
        return p && mons.has(`${p.side}|${p.name}`);
      });
    }
    if (e.type === 'weather') return !(e.kw && e.kw.upkeep);
    if (e.type === 'fieldstart' || e.type === 'fieldend') return / Terrain/.test(a[0] || '');
    if (e.type === 'sidestart' || e.type === 'sideend') return SCREEN.test(a[1] || '');
    return false;
  });
}

const nonZero = (b) => Object.entries(b || {}).filter(([, v]) => v !== 0).map(([k, v]) => `${k}${v > 0 ? '+' : ''}${v}`);

// What the log eventually reveals about each Pokémon (name -> { item, ability }), so a miss can be
// explained by "the item was only revealed later". Never used for the estimate itself.
function finalKnowledge(battle) {
  const known = {};
  for (const t of battle.turns) {
    for (const snaps of [t.start, t.end]) {
      for (const side of ['p1', 'p2']) {
        const m = snaps && snaps[side];
        if (!m) continue;
        const k = (known[`${side}|${m.name}`] = known[`${side}|${m.name}`] || { item: null, ability: null });
        k.item = k.item || m.item || m.lostItem;
        k.ability = k.ability || m.ability;
      }
    }
  }
  return known;
}

function checkBattle({ file, battle }, results, skipped) {
  const gen = battle.gen;
  if (!gen) return;
  const later = finalKnowledge(battle);

  for (const turn of battle.turns) {
    if (!turn.start) continue;
    for (const ev of turn.events) {
      if (ev.type !== 'move' || !usable(ev, turn.start)) continue;
      if (changedBeforeMove(turn, ev)) { skipped.count++; continue; }

      // Copy the start-of-turn Pokémon, then apply what happened earlier THIS turn that the
      // snapshot cannot know: Terastallizing happens before the move.
      const attacker = { ...turn.start[ev.side] };
      const defender = { ...turn.start[ev.target.side], hpPct: ev.hpBefore };
      for (const t of turn.events) {
        if (t.type !== 'tera' || t.seq >= ev.seq) continue;
        if (t.side === ev.side) { attacker.terastallized = true; attacker.teraType = t.teraType; }
        if (t.side === ev.target.side) { defender.terastallized = true; defender.teraType = t.teraType; }
      }

      const est = estimateDamage(gen, attacker, defender, ev.move, { field: turn.field });
      if (!est) continue;

      const actual = ev.damagePct;
      const off = actual < est.minPct - TOLERANCE ? actual - est.minPct
        : actual > est.maxPct + TOLERANCE ? actual - est.maxPct : 0;

      // Things that are in the estimate (modelled), and things that still are not (guesses).
      const modelled = [];
      if (turn.field.weather) modelled.push(`weather ${turn.field.weather}`);
      if (turn.field.terrain) modelled.push(turn.field.terrain);
      const screens = turn.field.screens[ev.target.side];
      if (screens.length) modelled.push(`screen ${screens.join('/')}`);
      modelled.push(...nonZero(attacker.boosts).map((x) => `attacker ${x}`), ...nonZero(defender.boosts).map((x) => `defender ${x}`));

      const guesses = [];
      const oppSide = battle.me === 'p1' ? 'p2' : 'p1';
      let oppItemKnown = null;
      let oppAbilityKnown = null;
      if (battle.me) {
        const o = attacker.side === oppSide ? attacker : defender;
        const role = o === attacker ? 'attacker' : 'defender';
        oppItemKnown = !!o.item;
        oppAbilityKnown = !!o.ability;
        const final = later[`${o.side}|${o.name}`] || {};
        for (const key of ['item', 'ability']) {
          if (o[key]) continue;
          guesses.push(final[key] ? `opp ${role} ${key} revealed later (${final[key]})` : `opp ${role} ${key} unknown`);
        }
      }
      if (attacker.status) guesses.push(`attacker ${attacker.status}`);

      results.push({
        file, turn: turn.turn, attacker: ev.mon, defender: ev.target.mon, move: ev.move,
        actual, min: est.minPct, max: est.maxPct, off, modelled, guesses, oppItemKnown, oppAbilityKnown,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Run and print
// ---------------------------------------------------------------------------

const results = [];
const skipped = { count: 0 };
for (const b of battles) checkBattle(b, results, skipped);

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
const inside = results.filter((r) => r.off === 0);
const near = results.filter((r) => Math.abs(r.off) <= NEAR);
const plain = results.filter((r) => !r.modelled.length);
const withEffects = results.filter((r) => r.modelled.length);

console.log(`Logs read: ${battles.length} (${duplicates} exact duplicate${duplicates === 1 ? '' : 's'} skipped)`);
console.log(`Hits checked: ${results.length}  (plus ${skipped.count} skipped: a boost, weather, terrain or screen changed earlier in the same turn)`);
console.log(`Inside the estimated range (+-${TOLERANCE} point): ${inside.length} (${pct(inside.length, results.length)})`);
console.log(`Within ${NEAR} points of the range:       ${near.length} (${pct(near.length, results.length)})`);
console.log(`  hits with nothing special going on:                     ${plain.length}, inside range ${pct(plain.filter((r) => r.off === 0).length, plain.length)}`);
console.log(`  hits with weather/terrain/boost/screen (now modelled):  ${withEffects.length}, inside range ${pct(withEffects.filter((r) => r.off === 0).length, withEffects.length)}`);

const withOpp = results.filter((r) => r.oppItemKnown !== null);
console.log(`  opponent item known at the start of the turn: ${pct(withOpp.filter((r) => r.oppItemKnown).length, withOpp.length)}, ability known: ${pct(withOpp.filter((r) => r.oppAbilityKnown).length, withOpp.length)} (of ${withOpp.length} hits)`);

const misses = results.filter((r) => r.off !== 0).sort((x, y) => Math.abs(y.off) - Math.abs(x.off)).slice(0, 10);
console.log(`\n${misses.length ? '10 biggest misses' : 'No misses'} (actual vs estimated range, in % of max HP):`);
for (const m of misses) {
  const dir = m.off > 0 ? 'too high' : 'too low';
  console.log(`  ${m.file.slice(0, 40)}  turn ${m.turn}: ${m.attacker} ${m.move} -> ${m.defender}`);
  console.log(`      actual ${m.actual}% vs ${m.min}-${m.max}%  (${Math.abs(m.off).toFixed(1)} points ${dir})`);
  console.log(`      in the estimate: ${m.modelled.length ? m.modelled.join(', ') : 'nothing special'}`);
  console.log(`      guess: ${m.guesses.length ? m.guesses.join(', ') : 'nothing on record explains it'}`);
}
