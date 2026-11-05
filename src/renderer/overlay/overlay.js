// overlay.js: the end-of-game card's page script. It only displays what main sends it.
// Everything is set with textContent / attributes, never innerHTML: names and avatar ids come
// from the server, and innerHTML would run any HTML hiding in them.
//
// What it reads from the review (see docs/review-format.md):
//   players.me / players.opponent, result.{won, forfeit, lastTurn}, moments[].label
// and two optional extras that main.js adds (src/core/card-extras.js):
//   avatars.{me, opponent}   Showdown avatar ids -> trainer pictures (a letter if missing)
//   evalSeries[{turn, eval}] who was ahead after each turn -> the graph (a flat line if missing)
// Or { room, error: true } / { room, spectated: true } when there is no review to show.

const $ = (id) => document.getElementById(id);
const card = $('card');

// ---------------------------------------------------------------------------
// Trainer pictures
// ---------------------------------------------------------------------------
const SPRITES = 'https://play.pokemonshowdown.com/sprites/';
// Showdown avatar ids are plain words/numbers ("steven", "265"), or "#name" for custom ones.
// Anything else is ignored, so a strange id can never become a strange URL.
const AVATAR_ID = /^#?[A-Za-z0-9_-]{1,40}$/;

function avatarUrl(avatar) {
  if (typeof avatar !== 'string' || !AVATAR_ID.test(avatar)) return null;
  return avatar[0] === '#' ? `${SPRITES}trainers-custom/${avatar.slice(1)}.png` : `${SPRITES}trainers/${avatar}.png`;
}

function setSprite(frame, avatar, name) {
  const img = frame.querySelector('img');
  frame.querySelector('.initial').textContent = (name || '?').trim().charAt(0).toUpperCase() || '?';
  const url = avatarUrl(avatar);
  if (!url) { frame.classList.add('empty'); img.removeAttribute('src'); return; }
  if (img.getAttribute('src') !== url) {  // the AI text arrives later and re-sends the review: do not reload the picture
    frame.classList.add('empty');         // a letter until the picture has loaded
    img.setAttribute('src', url);
  }
}
for (const id of ['sprite-me', 'sprite-opp']) {
  const frame = $(id);
  const img = frame.querySelector('img');
  img.addEventListener('load', () => frame.classList.remove('empty'));
  img.addEventListener('error', () => frame.classList.add('empty')); // offline or unknown avatar
}

// ---------------------------------------------------------------------------
// Graph: light = you were ahead, dark = you were behind
// ---------------------------------------------------------------------------
const NS = 'http://www.w3.org/2000/svg';
const G_W = 346, G_H = 78, G_MID = G_H / 2;
// Plain colour attributes (not CSS) so the graph looks the same in any renderer.
const AHEAD = '#b3b3b2', BEHIND = '#51504e';

function svg(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
  return node;
}

// The line crosses zero between two turns; add that point so the light and dark areas meet there.
function withCrossings(points) {
  const out = [];
  points.forEach((p, i) => {
    out.push(p);
    const q = points[i + 1];
    if (q && (p.v < 0) !== (q.v < 0) && p.v !== 0 && q.v !== 0) {
      out.push({ x: p.x + (q.x - p.x) * (p.v / (p.v - q.v)), v: 0 });
    }
  });
  return out;
}

function renderGraph(series) {
  const g = $('graph');
  g.replaceChildren();
  const pts = (Array.isArray(series) ? series : []).filter((p) => p && Number.isFinite(p.turn) && Number.isFinite(p.eval));
  g.appendChild(svg('line', { class: 'base', x1: 0, x2: G_W, y1: G_MID, y2: G_MID, stroke: BEHIND, 'stroke-width': 1 }));
  if (pts.length < 2) return;

  const first = pts[0].turn, span = pts[pts.length - 1].turn - first || 1;
  const peak = Math.max(12, ...pts.map((p) => Math.abs(p.eval)));   // fill the height, but never blow up a tiny swing
  const line = withCrossings(pts.map((p) => ({ x: ((p.turn - first) / span) * G_W, v: p.eval })));
  const area = (keep, cls, fill) => {
    const y = (v) => (G_MID - (keep(v) / peak) * G_MID).toFixed(1);
    const d = line.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${y(p.v)}`).join(' ') + ` L${G_W},${G_MID} L0,${G_MID} Z`;
    g.appendChild(svg('path', { class: cls, d, fill }));
  };
  area((v) => Math.max(v, 0), 'up', AHEAD);
  area((v) => Math.min(v, 0), 'down', BEHIND);
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
    const avatars = data.avatars || {};

    setTitle(kind);
    $('name-me').textContent = me;
    $('name-opp').textContent = opp;
    setSprite($('sprite-me'), avatars.me, me);
    setSprite($('sprite-opp'), avatars.opponent, opp);
    $('score').textContent = SCORES[kind];
    $('turns').textContent = `${turns} ${turns === 1 ? 'turn' : 'turns'}${result.forfeit ? ' · forfeit' : ''}`;

    renderGraph(data.evalSeries);

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
  const wave = Array.from({ length: 34 }, (_, i) => Math.round((-6 + 5 * Math.sin(i / 2.3) - (i % 7 === 3 ? 6 : 0) + (i === 8 ? 24 : 0) + (i > 31 ? 30 : 0)) * 10) / 10);
  render({
    players: { me: 'bikmet', opponent: 'anonOpponent3' },
    result: { won: true, forfeit: false, lastTurn: 33 },
    avatars: { me: '265', opponent: 'lucas' },
    evalSeries: wave.map((e, i) => ({ turn: i, eval: e })),
    moments: [{ label: 'great' }, { label: 'good' }, { label: 'mistake' }, { label: 'blunder' }],
  });
}
