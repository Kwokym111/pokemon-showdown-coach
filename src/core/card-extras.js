// card-extras.js: two extra pieces of data for the end-of-game card. Pure: no electron, fs
// or network.
//
//   avatars     { me, opponent }  the Showdown avatar ids (the card no longer shows trainer
//                                 pictures, so nothing reads this now; kept because it is harmless)
//   evalSeries  [{ turn, me, opp, eval }]  each team's HP after each turn, for the graph
//
// Neither is part of the review rules: they only exist to draw the card. main.js adds them
// to the review object right after buildReview (see cardExtras below).
//
// me and opp are each team's total HP as 0..100 (the sum of its Pokemon's HP% divided by team
// size), so 100 = everyone at full HP and one fainted Pokemon of six costs about 16.7. The card
// draws them as two lines. Pokemon that have not been seen yet count as full HP.
// eval = me - opp (-100..+100). The card no longer draws it, but it is cheap to keep.
// All of it only looks at HP, so it says who has more HP left, not who played better.

const round1 = (n) => Math.round(n * 10) / 10;

// "222/312", "68/100", "0 fnt", "50/100 par" -> 0..100, or null if unreadable.
function hpPct(condition) {
  if (typeof condition !== 'string') return null;
  const c = condition.trim();
  if (/^0\b/.test(c) || /\bfnt\b/.test(c)) return 0;
  const m = /^(\d+)\/(\d+)/.exec(c);
  return m && Number(m[2]) > 0 ? (Number(m[1]) / Number(m[2])) * 100 : null;
}

// "p2a: Name" -> { side: 'p2', name: 'Name' } (only the first ": " separates).
function who(ident) {
  const m = /^(p[12])[a-z]?: (.+)$/.exec(ident || '');
  return m ? { side: m[1], name: m[2] } : null;
}

function avatarsOf(battle) {
  const me = battle && battle.me;
  if (me !== 'p1' && me !== 'p2') return { me: null, opponent: null };
  const opp = me === 'p1' ? 'p2' : 'p1';
  const players = battle.players || {};
  return {
    me: (players[me] && players[me].avatar) || null,
    opponent: (players[opp] && players[opp].avatar) || null,
  };
}

function buildEvalSeries(lines, me) {
  if (!Array.isArray(lines) || (me !== 'p1' && me !== 'p2')) return [];
  const opp = me === 'p1' ? 'p2' : 'p1';
  const teamSize = { p1: 6, p2: 6 };
  const mons = { p1: {}, p2: {} }; // name -> { hp, fainted }

  // My whole team (with real conditions) is in the first complete |request|.
  for (const l of lines) {
    if (typeof l !== 'string' || !l.startsWith('|request|')) continue;
    try {
      const req = JSON.parse(l.slice('|request|'.length));
      for (const p of req.side.pokemon) {
        const w = who(p.ident);
        if (w && w.side === me) mons[me][w.name] = { hp: hpPct(p.condition) ?? 100, fainted: false };
      }
      break;
    } catch { /* damaged or cut off: try the next one */ }
  }

  const total = (side) => {
    const known = Object.values(mons[side]);
    const sum = known.reduce((a, m) => a + (m.fainted ? 0 : m.hp), 0);
    return sum + Math.max(0, teamSize[side] - known.length) * 100;
  };
  const evalNow = () => round1((total(me) - total(opp)) / teamSize[me]);
  // Each side divided by its OWN team size, so a 6v3 game still starts at 100 vs 100.
  const pct = (side) => round1(total(side) / teamSize[side]);

  const set = (ident, condition) => {
    const w = who(ident);
    const p = hpPct(condition);
    if (!w || p === null) return;
    const m = (mons[w.side][w.name] = mons[w.side][w.name] || { hp: 100, fainted: false });
    m.hp = p;
    m.fainted = p === 0;
  };

  const series = [];
  let turn = 0;
  const push = (t) => {
    const point = { turn: t, me: pct(me), opp: pct(opp), eval: evalNow() };
    if (series.length && series[series.length - 1].turn === t) series[series.length - 1] = point;
    else series.push(point);
  };

  for (const line of lines) {
    if (typeof line !== 'string' || line[0] !== '|') continue;
    const parts = line.split('|');
    const cmd = parts[1];
    if (cmd === 'teamsize') {
      if (parts[2] === 'p1' || parts[2] === 'p2') teamSize[parts[2]] = Number(parts[3]) || 6;
    } else if (cmd === 'switch' || cmd === 'drag') set(parts[2], parts[4]);
    else if (cmd === '-damage' || cmd === '-heal' || cmd === '-sethp') set(parts[2], parts[3]);
    else if (cmd === 'faint') set(parts[2], '0 fnt');
    else if (cmd === 'turn') {
      push(turn);            // the turn that just ended (0 = the lead-in)
      turn = Number(parts[2]) || turn + 1;
    }
  }
  if (turn > 0) push(turn);  // the last turn, which has no |turn| line after it
  return series;
}

// What main.js adds to the review: Object.assign(review, cardExtras(battle, lines)).
function cardExtras(battle, lines) {
  return { avatars: avatarsOf(battle), evalSeries: buildEvalSeries(lines, battle && battle.me) };
}

module.exports = { cardExtras, avatarsOf, buildEvalSeries };
