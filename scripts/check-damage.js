// scripts/check-damage.js: how close are damage.js estimates to what really happened?
// Usage: npm run check-damage [-- <extra folder of .log files>]
// Always reads test-data/. Pass a folder (e.g. the live battle-logs folder) to add more.
// Not part of the app. Its numbers decide whether state.js must track weather, boosts and
// screens before the damage-based review rules are written.
//
// For every damaging hit by either side it compares the log's real damage (% of max HP)
// with the estimate's minPct-maxPct. Only clean, comparable hits are used, see usable().

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
// Context tracking: what the estimate does NOT know about, used to guess why it missed.
// state.js keeps these as generic events, so we follow them here, in order.
// ---------------------------------------------------------------------------

function newContext() {
  return { weather: null, terrain: null, screens: { p1: new Set(), p2: new Set() }, boosts: new Map() };
}

const boostKey = (side, name) => `${side}|${name}`;

function applyEvent(ctx, ev) {
  const a = ev.args || [];
  const id = a[0] ? parseIdent(a[0]) : null;
  switch (ev.type) {
    case 'weather': ctx.weather = a[0] === 'none' ? null : a[0]; break;
    case 'fieldstart': if (/Terrain/.test(a[0] || '')) ctx.terrain = a[0].replace('move: ', ''); break;
    case 'fieldend': if (/Terrain/.test(a[0] || '')) ctx.terrain = null; break;
    case 'sidestart': case 'sideend': {
      const side = (a[0] || '').slice(0, 2);
      const name = (a[1] || '').replace('move: ', '');
      if (ctx.screens[side] && /Reflect|Light Screen|Aurora Veil/.test(name)) {
        ctx.screens[side][ev.type === 'sidestart' ? 'add' : 'delete'](name);
      }
      break;
    }
    case 'boost': case 'unboost': case 'setboost': {
      if (!id) break;
      const k = boostKey(id.side, id.name);
      const b = ctx.boosts.get(k) || {};
      const n = Number(a[2]) || 0;
      b[a[1]] = ev.type === 'setboost' ? n : (b[a[1]] || 0) + (ev.type === 'boost' ? n : -n);
      ctx.boosts.set(k, b);
      break;
    }
    case 'clearboost': case 'clearnegativeboost': if (id) ctx.boosts.delete(boostKey(id.side, id.name)); break;
    case 'clearallboost': ctx.boosts.clear(); break;
    case 'switch': case 'drag': ctx.boosts.delete(boostKey(ev.side, ev.mon)); break; // boosts end on switch-out
    default: break;
  }
}

const nonZero = (b) => Object.entries(b || {}).filter(([, v]) => v !== 0).map(([k, v]) => `${k}${v > 0 ? '+' : ''}${v}`);

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

function checkBattle({ file, battle }, results) {
  const ctx = newContext();
  const gen = battle.gen;
  if (!gen) return;

  for (const turn of battle.turns) {
    if (!turn.start) { for (const ev of turn.events) applyEvent(ctx, ev); continue; }
    for (const ev of turn.events) {
      if (ev.type === 'move' && usable(ev, turn.start)) {
        // Copy the start-of-turn Pokémon, then apply what happened earlier THIS turn that the
        // snapshot cannot know: Terastallizing happens before the move.
        const attacker = { ...turn.start[ev.side] };
        const defender = { ...turn.start[ev.target.side], hpPct: ev.hpBefore };
        for (const t of turn.events) {
          if (t.type !== 'tera' || t.seq >= ev.seq) continue;
          if (t.side === ev.side) { attacker.terastallized = true; attacker.teraType = t.teraType; }
          if (t.side === ev.target.side) { defender.terastallized = true; defender.teraType = t.teraType; }
        }

        const est = estimateDamage(gen, attacker, defender, ev.move);
        if (est) {
          const actual = ev.damagePct;
          const off = actual < est.minPct - TOLERANCE ? actual - est.minPct
            : actual > est.maxPct + TOLERANCE ? actual - est.maxPct : 0;
          const causes = [];
          if (ctx.weather) causes.push(`weather ${ctx.weather}`);
          if (ctx.terrain) causes.push(ctx.terrain);
          const boosts = [...nonZero(ctx.boosts.get(boostKey(ev.side, ev.mon))).map((x) => `attacker ${x}`),
            ...nonZero(ctx.boosts.get(boostKey(ev.target.side, ev.target.mon))).map((x) => `defender ${x}`)];
          causes.push(...boosts);
          if (ctx.screens[ev.target.side].size) causes.push(`screen ${[...ctx.screens[ev.target.side]].join('/')}`);
          const oppSide = battle.me === 'p1' ? 'p2' : 'p1';
          if (battle.me && !attacker.item && attacker.side === oppSide) causes.push('opp attacker item unknown');
          if (battle.me && !attacker.ability && attacker.side === oppSide) causes.push('opp attacker ability unknown');
          if (battle.me && !defender.item && defender.side === oppSide) causes.push('opp defender item unknown');
          if (battle.me && !defender.ability && defender.side === oppSide) causes.push('opp defender ability unknown');
          if (attacker.status) causes.push(`attacker ${attacker.status}`);

          results.push({
            file, turn: turn.turn, attacker: ev.mon, defender: ev.target.mon, move: ev.move,
            actual, min: est.minPct, max: est.maxPct, off, causes,
            // Things state.js does not track. If one of these is present the estimate was
            // never going to be exact, so a miss is not a bug in damage.js.
            tracked: causes.filter((c) => /^(weather|screen|attacker [a-z]+[+-]|defender [a-z]+[+-]|.*Terrain)/.test(c)).length > 0,
          });
        }
      }
      applyEvent(ctx, ev);
    }
  }
}

// ---------------------------------------------------------------------------
// Run and print
// ---------------------------------------------------------------------------

const results = [];
for (const b of battles) checkBattle(b, results);

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
const inside = results.filter((r) => r.off === 0);
const near = results.filter((r) => Math.abs(r.off) <= NEAR);
const clean = results.filter((r) => !r.tracked);
const cleanInside = clean.filter((r) => r.off === 0);
const withCtx = results.filter((r) => r.tracked);
const withCtxInside = withCtx.filter((r) => r.off === 0);

console.log(`Logs read: ${battles.length} (${duplicates} exact duplicate${duplicates === 1 ? '' : 's'} skipped)`);
console.log(`Hits checked: ${results.length}`);
console.log(`Inside the estimated range (+-${TOLERANCE} point): ${inside.length} (${pct(inside.length, results.length)})`);
console.log(`Within ${NEAR} points of the range:       ${near.length} (${pct(near.length, results.length)})`);
console.log(`  hits with no weather/terrain/boost/screen on record: ${clean.length}, inside range ${pct(cleanInside.length, clean.length)}`);
console.log(`  hits with weather/terrain/boost/screen on record:    ${withCtx.length}, inside range ${pct(withCtxInside.length, withCtx.length)}`);

const misses = results.filter((r) => r.off !== 0).sort((x, y) => Math.abs(y.off) - Math.abs(x.off)).slice(0, 10);
console.log(`\n${misses.length ? '10 biggest misses' : 'No misses'} (actual vs estimated range, in % of max HP):`);
for (const m of misses) {
  const dir = m.off > 0 ? 'too high' : 'too low';
  console.log(`  ${m.file.slice(0, 40)}  turn ${m.turn}: ${m.attacker} ${m.move} -> ${m.defender}`);
  console.log(`      actual ${m.actual}% vs ${m.min}-${m.max}%  (${Math.abs(m.off).toFixed(1)} points ${dir})`);
  console.log(`      guess: ${m.causes.length ? m.causes.join(', ') : 'nothing on record explains it'}`);
}
