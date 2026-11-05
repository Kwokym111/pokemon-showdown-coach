// panel-live.js: the #live section of the panel.
// It only displays what main sent over IPC (rule 1); all the work happens in the main process.
//
// SECURITY: species and move names come from the server, so everything is built with
// createElement + textContent. innerHTML is never used. CSS class names only ever come from
// the fixed TYPE_CLASSES list below, never from the data itself.

// Everything is wrapped in a function on purpose: the panel's scripts are plain <script> tags
// that share ONE global scope, and panel-review.js (loaded after this file) already declares
// its own global `el` and `render`. Without the wrapper those would silently replace the
// helpers below and the live section would stay empty.
(function () {
const PLACEHOLDER = 'Live info appears during your battles.';
const liveEl = document.getElementById('live');

// Lower-cased names of the 18 types. A chip gets a colour class only if its type is in here.
const TYPE_CLASSES = new Set([
  'normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground',
  'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy',
]);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// A coloured type label. suffix is e.g. "x4".
function chip(type, suffix) {
  const lower = typeof type === 'string' ? type.toLowerCase() : '';
  const node = el('span', 'type-chip ' + (TYPE_CLASSES.has(lower) ? 'type-' + lower : 'type-unknown'));
  node.textContent = type || '?';
  if (suffix) node.appendChild(el('span', 'chip-x', suffix));
  return node;
}

// 4 -> "x4", 0.5 -> "x½", 0.25 -> "x¼" (fractions read faster than decimals in a tiny chip)
const FRACTIONS = { 0.5: '½', 0.25: '¼' };
const times = (x) => 'x' + (FRACTIONS[x] || x);

// One labelled row, e.g. "Weak to [Ice x4] [Dragon x2]". Skipped when there is nothing to list.
function row(label, items, emptyText) {
  if (items.length === 0 && emptyText === undefined) return null;
  const r = el('div', 'live-row');
  r.appendChild(el('span', 'live-label', label));
  if (items.length === 0) r.appendChild(el('span', 'live-muted', emptyText));
  for (const it of items) r.appendChild(it);
  return r;
}

function typeHeader(heading, mon) {
  const head = el('div', 'live-mon');
  head.appendChild(el('span', 'live-side', heading));
  head.appendChild(el('span', 'live-name', mon.species || mon.name || '?'));
  for (const t of mon.types) head.appendChild(chip(t));
  if (mon.terastallized) head.appendChild(el('span', 'tera-badge', 'Tera'));
  return head;
}

function matchupRows(box, mon) {
  // Only chips for types with an effect. Neutral types are not listed (nothing to look up).
  // Every weakness and resistance shows its multiplier, so the two lists read the same way.
  const weak = mon.weak.map((w) => chip(w.type, times(w.x)));
  const resist = mon.resist.map((r) => chip(r.type, times(r.x)));
  const immune = mon.immune.map((t) => chip(t));
  for (const r of [row('Weak to', weak), row('Resists', resist), row('Immune to', immune)]) {
    if (r) box.appendChild(r);
  }
}

function opponentBlock(opp) {
  const box = el('div', 'live-block');
  const head = typeHeader('Opponent', opp);
  if (typeof opp.hpPct === 'number') head.appendChild(el('span', 'live-hp', Math.round(opp.hpPct) + '%'));
  if (opp.status) head.appendChild(el('span', 'live-status', String(opp.status).toUpperCase()));
  box.appendChild(head);
  if (opp.types.length === 0) {
    box.appendChild(el('div', 'live-muted', 'Types not available for this Pokémon.'));
  } else {
    matchupRows(box, opp);
  }
  const moves = opp.revealedMoves.map((m) => {
    const wrap = el('span', 'move-seen');
    wrap.appendChild(el('span', 'move-name', m.name));
    if (m.type) wrap.appendChild(chip(m.type));
    return wrap;
  });
  box.appendChild(row('Moves seen', moves, 'none yet'));
  return box;
}

function meBlock(me) {
  const box = el('div', 'live-block');
  box.appendChild(typeHeader('You', me));
  if (me.types.length === 0) box.appendChild(el('div', 'live-muted', 'Types not available for this Pokémon.'));
  else matchupRows(box, me);
  return box;
}

function render(info) {
  liveEl.textContent = ''; // clears the old content
  if (info === null) {
    liveEl.appendChild(el('div', 'live-muted', PLACEHOLDER));
    return;
  }
  const header = el('div', 'live-header');
  header.appendChild(el('span', 'live-title', 'REFERENCE · revealed info only'));
  header.appendChild(el('span', 'live-turn', 'Turn ' + info.turn));
  liveEl.appendChild(header);

  if (info.opponent) liveEl.appendChild(opponentBlock(info.opponent));
  else liveEl.appendChild(el('div', 'live-muted', 'No opposing Pokémon on the field.'));
  if (info.me) liveEl.appendChild(meBlock(info.me));
  if (info.ended) liveEl.appendChild(el('div', 'live-muted live-over', 'Battle over'));
}

// data is { room, info }. info === null means "nothing to show / clear".
window.panelAPI.onLiveInfo(({ info }) => {
  try {
    render(info);
  } catch (err) {
    // A display bug must never break the rest of the panel.
    liveEl.textContent = PLACEHOLDER;
    console.error('[panel-live] render failed:', err.message);
  }
});

render(null);
})();
