// overlay.js: the end-of-game card's page script. It only displays what main sends it.
// Everything is set with textContent / attributes, never innerHTML: player names come from the
// server, and innerHTML would run any HTML hiding in them.
//
// What it reads from the review (see docs/review-format.md):
//   players.me / players.opponent, result.{won, forfeit, lastTurn}, moments[].label
// and one optional extra that main.js adds (src/core/card-extras.js):
//   evalSeries[{turn, me, opp}] each team's HP% after each turn -> the graph (hidden if missing)
// (card-extras also sends `avatars`; the card no longer shows trainer pictures, so it ignores it.)
// Or { room, error: true } / { room, spectated: true } when there is no review to show.

const $ = (id) => document.getElementById(id);
const card = $('card');

// ---------------------------------------------------------------------------
// Graph: each team's HP over the battle, as two lines that both start at 100%
// ---------------------------------------------------------------------------
// Top to bottom: a legend strip, the plot (gridlines at 100 / 50 / 0%), a row of turn numbers.
// The legend and labels are OUTSIDE the plot so they never sit on top of a line. Left to right:
// a small gutter for the "100%" labels, then the plot.
const NS = 'http://www.w3.org/2000/svg';
const G_W = 476;                         // the card's content width; must match the viewBox in index.html
const X0 = 34, X1 = G_W - 8;             // plot left (after the % labels) and right
const PLOT_H = 90;                       // distance between the 100% line and the 0% line
const LEGEND_H = 22;
const Y100 = LEGEND_H + 4;               // 4px of room so the thick line at 100% is not clipped
const Y0 = Y100 + PLOT_H;
const G_H = Y0 + 20;                     // 136, room for the turn numbers; must match the viewBox
// Plain colour attributes (not CSS) so the graph looks the same in any renderer.
// Cyan and orange read differently even with red-green colour blindness (unlike green and red).
const ME = '#5ec8e5', OPP = '#ef8427';   // = --great and --mistake in overlay.css
const LABEL = '#cdd6f4', AXIS = '#a6adc8', GRID = '#4a4745';

// SVG text cannot cut itself off with "…", so long names are shortened here. The full names are
// in the header of the card.
const clip = (s, n = 16) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function svg(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
  return node;
}

function label(text, x, y, anchor, fill, weight, size = 11) {
  const t = svg('text', { x, y, 'text-anchor': anchor, fill, 'font-size': size, 'font-weight': weight });
  t.textContent = text;
  return t;
}

function renderGraph(series, oppName) {
  const g = $('graph');
  g.replaceChildren();
  const pts = (Array.isArray(series) ? series : []).filter(
    (p) => p && Number.isFinite(p.turn) && Number.isFinite(p.me) && Number.isFinite(p.opp));
  // Fewer than two points is not a graph; an empty chart under the title would mislead.
  $('graph-block').hidden = pts.length < 2;
  if (pts.length < 2) return;

  const first = pts[0].turn, last = pts[pts.length - 1].turn, span = last - first || 1;
  const x = (turn) => X0 + ((turn - first) / span) * (X1 - X0);
  const y = (pct) => Y0 - (Math.min(100, Math.max(0, pct)) / 100) * PLOT_H;

  // Gridlines first, so the lines go over them.
  for (const pct of [100, 50, 0]) {
    g.appendChild(svg('line', { class: 'grid', x1: X0, x2: X1, y1: y(pct), y2: y(pct), stroke: GRID, 'stroke-width': 1 }));
    g.appendChild(label(`${pct}%`, X0 - 6, y(pct) + 3.5, 'end', AXIS, 400, 10));
  }

  // The opponent's line goes first and is thicker; yours goes on top and thinner. Where both are
  // at the same HP (the start, or any stretch with no damage) you still see an orange edge instead
  // of the opponent's line disappearing under yours.
  const path = (key, cls, stroke, width) => {
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.turn).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
    g.appendChild(svg('path', { class: cls, d, fill: 'none', stroke, 'stroke-width': width, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  };
  path('opp', 'line-opp', OPP, 4);
  path('me', 'line-me', ME, 2);

  // Legend: a short sample of each line, then whose it is.
  const ly = 10;
  g.appendChild(svg('line', { x1: X0, x2: X0 + 16, y1: ly, y2: ly, stroke: ME, 'stroke-width': 3, 'stroke-linecap': 'round' }));
  g.appendChild(label('You', X0 + 22, ly + 4, 'start', LABEL, 700));
  const ox = X0 + 86;
  g.appendChild(svg('line', { x1: ox, x2: ox + 16, y1: ly, y2: ly, stroke: OPP, 'stroke-width': 3, 'stroke-linecap': 'round' }));
  g.appendChild(label(clip(oppName || 'Opponent'), ox + 22, ly + 4, 'start', LABEL, 700));

  // Turn numbers: first, middle (only if there is room), last. Turn 0 is the lead-in before turn 1.
  const axisY = G_H - 4;
  g.appendChild(label(first === 0 ? 'Start' : `Turn ${first}`, X0, axisY, 'start', AXIS, 400));
  const mid = Math.round(first + span / 2);
  if (span >= 8) g.appendChild(label(`Turn ${mid}`, x(mid), axisY, 'middle', AXIS, 400));
  g.appendChild(label(`Turn ${last}`, X1, axisY, 'end', AXIS, 400));
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------
const TITLES = { win: ['Battle', 'Won!'], loss: ['Battle', 'Lost!'], unknown: ['Game', 'Over'] };
const SCORES = { win: '1 - 0', loss: '0 - 1', unknown: '– –' };
const LABELS = ['great', 'good', 'mistake', 'blunder'];

function setTitle(kind) {
  const [a, b] = TITLES[kind];
  const spans = $('title').children;
  spans[0].textContent = a;
  spans[1].textContent = b;
  card.classList.remove('win', 'loss');
  if (kind !== 'unknown') card.classList.add(kind);
}

// No summary to draw: show a message under a plain "Game Over".
function showMessage(text) {
  setTitle('unknown');
  $('message').textContent = text;
  card.classList.remove('ready');
}

function render(data) {
  try {
    if (!data || data.error) return showMessage('Couldn\'t build the review for this game.');
    if (data.spectated) return showMessage('You were spectating this battle, so there\'s nothing to review.');

    const result = data.result || {};
    const kind = result.won === true ? 'win' : result.won === false ? 'loss' : 'unknown';
    const me = (data.players && data.players.me) || 'You';
    const opp = (data.players && data.players.opponent) || 'Opponent';
    const turns = Number.isFinite(result.lastTurn) ? result.lastTurn : 0;
    const moments = Array.isArray(data.moments) ? data.moments : [];

    setTitle(kind);
    $('name-me').textContent = me;
    $('name-opp').textContent = opp;
    $('score').textContent = SCORES[kind];
    $('turns').textContent = `${turns} ${turns === 1 ? 'turn' : 'turns'}${result.forfeit ? ' · forfeit' : ''}`;

    // The legend calls you "You" (your own name is already in the header).
    renderGraph(data.evalSeries, data.players && data.players.opponent);

    for (const label of LABELS) {
      const n = moments.filter((m) => m && m.label === label).length;
      const count = $(`count-${label}`);
      count.textContent = String(n);
      count.classList.toggle('zero', n === 0);
    }
    $('note').textContent = moments.length === 0 ? 'No key moments in this game. The coach only flags moments it\'s confident about.' : '';

    $('message').textContent = '';
    card.classList.add('ready');
  } catch (err) {
    console.error('[overlay] could not draw the review:', err);
    showMessage('Couldn\'t show the review for this game.');
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
const api = window.review; // from overlay-preload.js; undefined when this file is opened in a plain browser
const close = () => (api ? api.close() : console.log('close'));
$('close').addEventListener('click', close);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

if (api) {
  api.onReview(render);
  // main.js also sends 'ai-status' for the side panel. This card has no room for it.
} else {
  // Opened by double-clicking index.html: show example data so the design can be previewed.
  // Both teams start at 100%. I fall behind in the middle, then win it back.
  const clamp = (v) => Math.round(Math.max(0, Math.min(100, v)) * 10) / 10;
  const demo = Array.from({ length: 34 }, (_, i) => ({
    turn: i,
    me: clamp(100 - i * 1.1 - (i > 10 ? 14 : 0) - (i > 22 ? 20 : 0)),
    opp: clamp(100 - i * 1.6 - (i > 14 ? 18 : 0) - (i > 28 ? 30 : 0)),
  }));
  render({
    players: { me: 'bikmet', opponent: 'anonOpponent3' },
    result: { won: true, forfeit: false, lastTurn: 33 },
    evalSeries: demo,
    moments: [{ label: 'great' }, { label: 'good' }, { label: 'mistake' }, { label: 'blunder' }],
  });
}
