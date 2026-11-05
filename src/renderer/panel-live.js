// panel-live.js: the #live section of the panel (the opponent card shown during a battle).
// It only displays what main sent over IPC (rule 1); all the work happens in the main process.
//
// SECURITY: species, move and ability names come from the server, so everything is built with
// createElement + textContent. innerHTML is never used. CSS class names only ever come from
// the fixed lists below (TYPE_CLASSES, HP_CLASSES, STAT_CLASSES), never from the data itself.
//
// WHY WE DIFF: `info` arrives on every captured frame, and the CSS animations (fade-in, stat
// bars growing, a move slot flipping) play when an element is CREATED. Rebuilding the whole
// card each time would replay them constantly. So the card is built once per opponent Pokémon
// and afterwards only the parts that changed are touched.

// Everything is wrapped in a function on purpose: the panel's scripts are plain <script> tags
// that share ONE global scope, and panel-review.js (loaded after this file) already declares
// its own global `el` and `render`. Without the wrapper those would silently replace the
// helpers below and the live section would stay empty.
(function () {
const liveEl = document.getElementById('live');
const MIN_MOVE_SLOTS = 4;

// Lower-cased names of the 18 types. A chip gets a colour class only if its type is in here.
const TYPE_CLASSES = new Set([
  'normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground',
  'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy',
]);

const STATS = [['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe']];

// Same id rule as the parser's toId: lets "Tablets of Ruin" match "tabletsofruin".
const toId = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function typeClass(type) {
  const lower = typeof type === 'string' ? type.toLowerCase() : '';
  return TYPE_CLASSES.has(lower) ? 'type-' + lower : 'type-unknown';
}

// A coloured type label. suffix is e.g. "x4".
function chip(type, suffix) {
  const node = el('span', 'type-chip ' + typeClass(type));
  node.textContent = type || '?';
  if (suffix) node.appendChild(el('span', 'chip-x', suffix));
  return node;
}

// 4 -> "x4", 0.5 -> "x½", 0.25 -> "x¼" (fractions read faster than decimals in a tiny chip)
const FRACTIONS = { 0.5: '½', 0.25: '¼' };
const times = (x) => 'x' + (FRACTIONS[x] || x);

// Fixed class choices (values from the data never become class names directly).
function hpClass(pct) {
  if (pct > 50) return 'hp-high';
  if (pct > 20) return 'hp-mid';
  return 'hp-low';
}
function statClass(v) {
  if (v < 50) return 'stat-1';
  if (v < 80) return 'stat-2';
  if (v < 100) return 'stat-3';
  if (v < 130) return 'stat-4';
  return 'stat-5';
}

// ---------------------------------------------------------------------------
// Tooltip: one shared div on <body>. It is NOT inside #live because #live scrolls and would
// clip it. Shown on mouseenter/focus, hidden on mouseleave/blur. We use this instead of the
// native `title` attribute because that one is slow and cannot be styled.
// ---------------------------------------------------------------------------
const tip = el('div', 'live-tip');
tip.hidden = true;
document.body.appendChild(tip);

function hideTip() { tip.hidden = true; }

function showTip(target, lines) {
  tip.textContent = '';
  for (const l of lines) tip.appendChild(el('div', l.cls || 'tip-line', l.text));
  tip.hidden = false;
  const r = target.getBoundingClientRect();
  const margin = 6;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  // Keep it inside the panel's width, and flip above the target when there is no room below.
  const left = Math.max(margin, Math.min(r.left, window.innerWidth - w - margin));
  let top = r.bottom + margin;
  if (top + h > window.innerHeight - margin) top = Math.max(margin, r.top - h - margin);
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

// Makes `node` focusable and wires the tooltip. `getLines` is called on show.
function attachTip(node, getLines) {
  node.tabIndex = 0;
  const show = () => showTip(node, getLines());
  node.addEventListener('mouseenter', show);
  node.addEventListener('focus', show);
  node.addEventListener('mouseleave', hideTip);
  node.addEventListener('blur', hideTip);
}

liveEl.addEventListener('scroll', hideTip);

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------

// One labelled row, e.g. "Weak to [Ice x4] [Dragon x2]". Skipped when there is nothing to list.
function row(label, items) {
  if (items.length === 0) return null;
  const r = el('div', 'live-row');
  r.appendChild(el('span', 'live-label', label));
  for (const it of items) r.appendChild(it);
  return r;
}

function weakChips(mon) { return mon.weak.map((w) => chip(w.type, times(w.x))); }

function fillMatchups(box, mon) {
  box.textContent = '';
  if (mon.types.length === 0) {
    box.appendChild(el('div', 'live-muted', 'Types not available for this Pokémon.'));
    return;
  }
  // Only chips for types with an effect. Neutral types are not listed (nothing to look up).
  const rows = [
    row('Weak to', weakChips(mon)),
    row('Resists', mon.resist.map((r) => chip(r.type, times(r.x)))),
    row('Immune to', mon.immune.map((t) => chip(t))),
  ];
  for (const r of rows) if (r) box.appendChild(r);
}

function fillTypes(box, mon) {
  box.textContent = '';
  for (const t of mon.types) box.appendChild(chip(t));
}

// Labels for stat stages. Display names only; the stat ids come from the data.
const STAGE_LABELS = {
  atk: ['Atk', 'Attack'], def: ['Def', 'Defense'], spa: ['SpA', 'Sp. Atk'], spd: ['SpD', 'Sp. Def'],
  spe: ['Spe', 'Speed'], accuracy: ['Acc', 'Accuracy'], evasion: ['Eva', 'Evasion'],
};

// A small neutral pill with an optional tooltip. cls comes from a fixed list below.
function effectChip(text, cls, tipLines) {
  const node = el('span', 'effect-chip ' + cls, text);
  if (tipLines) attachTip(node, () => tipLines);
  return node;
}

// "Effects: [Paralyzed] [Atk +2] [Spe -1]": the status and stat stages shown in the log.
// Hidden when there is nothing, so a plain Pokémon takes no space. Colour only shows which
// way a stage moved (up or down); the wording stays neutral.
function fillEffects(box, mon) {
  box.textContent = '';
  const chips = [];
  if (mon.statusName) chips.push(effectChip(mon.statusName, 'effect-status'));
  // Temporary effects like Leech Seed or Substitute; the tooltip is the move's description.
  for (const v of mon.volatiles || []) {
    chips.push(effectChip(v.name, 'effect-volatile',
      v.shortDesc ? [{ cls: 'tip-title', text: v.name }, { cls: 'tip-desc', text: v.shortDesc }] : null));
  }
  for (const b of mon.boosts || []) {
    const names = STAGE_LABELS[b.stat] || [b.stat, b.stat];
    const sign = b.stages > 0 ? '+' : '';
    chips.push(effectChip(names[0] + ' ' + sign + b.stages, b.stages > 0 ? 'stage-up' : 'stage-down',
      [{ text: names[1] + ': ' + sign + b.stages + (Math.abs(b.stages) === 1 ? ' stage' : ' stages') }]));
  }
  box.hidden = chips.length === 0;
  if (chips.length === 0) return;
  const r = el('div', 'live-row');
  r.appendChild(el('span', 'live-label', 'Effects'));
  for (const c of chips) r.appendChild(c);
  box.appendChild(r);
}

function moveTipLines(m) {
  const power = m.basePower ? String(m.basePower) : '-';
  const acc = m.accuracy === true ? 'never misses' : (typeof m.accuracy === 'number' ? m.accuracy + '%' : '-');
  const lines = [
    { cls: 'tip-title', text: m.name },
    { text: (m.type || '?') + ' · ' + (m.category || '?') },
    { text: 'Power: ' + power + ' · Accuracy: ' + acc },
  ];
  if (m.shortDesc) lines.push({ cls: 'tip-desc', text: m.shortDesc });
  return lines;
}

function emptySlot() {
  // No tooltip, no type, no hint: a "?" slot must not say anything about hidden moves.
  return el('div', 'move-slot move-empty', '?');
}

function revealedSlot(m, animate) {
  const slot = el('div', 'move-slot move-known ' + typeClass(m.type) + (animate ? ' just-revealed' : ''));
  slot.appendChild(el('span', 'move-slot-name', m.name));
  if (m.category) slot.appendChild(el('span', 'move-slot-cat', m.category));
  attachTip(slot, () => moveTipLines(m));
  return slot;
}

// ---------------------------------------------------------------------------
// The opponent card. build() makes the DOM once and returns references (`refs`) to the parts
// that can change; update*() functions change only those parts.
// ---------------------------------------------------------------------------

function buildOpponent(opp) {
  const card = el('div', 'opp-card enter');
  const refs = { card, key: opp.name + '|' + opp.species };

  // Header: name, tera badge, status; types; HP bar.
  const head = el('div', 'opp-head');
  const nameRow = el('div', 'opp-name-row');
  nameRow.appendChild(el('span', 'opp-name', opp.name || opp.species || '?'));
  if (opp.species && opp.species !== opp.name) nameRow.appendChild(el('span', 'opp-species', opp.species));
  refs.tera = el('span', 'tera-badge', 'Tera');
  refs.fainted = el('span', 'faint-badge', 'Fainted');
  nameRow.appendChild(refs.tera);
  nameRow.appendChild(refs.fainted);
  head.appendChild(nameRow);

  refs.types = el('div', 'opp-types');
  head.appendChild(refs.types);

  const hpRow = el('div', 'hp-row');
  const track = el('div', 'hp-track');
  refs.hpFill = el('div', 'hp-fill');
  track.appendChild(refs.hpFill);
  refs.hpText = el('span', 'hp-text');
  hpRow.appendChild(track);
  hpRow.appendChild(refs.hpText);
  head.appendChild(hpRow);
  card.appendChild(head);

  // Status and stat stages (what the log has shown); hidden while there are none.
  refs.effects = el('div', 'opp-effects');
  card.appendChild(refs.effects);

  refs.matchups = el('div', 'opp-matchups');
  card.appendChild(refs.matchups);

  // Moves: always 4 slots (more only if the Pokémon has really shown more).
  const movesSec = el('div', 'opp-section');
  movesSec.appendChild(el('div', 'sec-title', 'Moves'));
  refs.moveGrid = el('div', 'move-grid');
  movesSec.appendChild(refs.moveGrid);
  card.appendChild(movesSec);

  // Possible abilities (hidden when the generation has none and none was revealed).
  refs.abilitySec = el('div', 'opp-section');
  refs.abilitySec.appendChild(el('div', 'sec-title', 'Possible abilities'));
  refs.abilityList = el('div', 'ability-list');
  refs.abilitySec.appendChild(refs.abilityList);
  card.appendChild(refs.abilitySec);

  // Base stats: static species data. Bars grow from 0 through a CSS animation on creation.
  if (opp.baseStats) {
    const statSec = el('div', 'opp-section');
    statSec.appendChild(el('div', 'sec-title', 'Base stats'));
    let total = 0;
    for (const [key, label] of STATS) {
      const v = opp.baseStats[key];
      if (typeof v !== 'number') continue;
      total += v;
      const r = el('div', 'stat-row');
      r.appendChild(el('span', 'stat-label', label));
      const t = el('div', 'stat-track');
      const fill = el('div', 'stat-fill ' + statClass(v));
      fill.style.width = Math.min(100, (v / 255) * 100) + '%'; // value / 255, as designed
      t.appendChild(fill);
      r.appendChild(t);
      r.appendChild(el('span', 'stat-value', String(v)));
      statSec.appendChild(r);
    }
    const tr = el('div', 'stat-row stat-total');
    tr.appendChild(el('span', 'stat-label', 'Total'));
    tr.appendChild(el('div', 'stat-track stat-track-empty'));
    tr.appendChild(el('span', 'stat-value', String(total)));
    statSec.appendChild(tr);
    card.appendChild(statSec);
  }

  // Fill the variable parts. No move animation on the first build: moves seen earlier in the
  // battle (the Pokémon coming back) just appear.
  refs.typesKey = null;
  refs.effectsKey = null;
  refs.moveNames = [];
  refs.abilityKey = undefined;
  updateOpponent(refs, opp, false);
  return refs;
}

function updateOpponent(refs, opp, animate) {
  // HP and status change often.
  if (typeof opp.hpPct === 'number') {
    const pct = Math.max(0, Math.min(100, opp.hpPct));
    refs.hpFill.style.width = pct + '%';
    refs.hpFill.className = 'hp-fill ' + hpClass(pct);
    refs.hpText.textContent = Math.round(pct) + '%';
  } else {
    refs.hpFill.style.width = '0%';
    refs.hpText.textContent = '';
  }
  refs.tera.hidden = !opp.terastallized;
  refs.fainted.hidden = !opp.fainted;
  refs.card.classList.toggle('is-fainted', !!opp.fainted);

  // Types and matchups only change with Tera (or a type-changing move).
  const typesKey = opp.types.join(',') + '|' + opp.terastallized;
  if (typesKey !== refs.typesKey) {
    refs.typesKey = typesKey;
    fillTypes(refs.types, opp);
    fillMatchups(refs.matchups, opp);
  }

  const effectsKey = JSON.stringify([opp.status, opp.boosts, opp.volatiles]);
  if (effectsKey !== refs.effectsKey) {
    refs.effectsKey = effectsKey;
    fillEffects(refs.effects, opp);
  }

  updateMoves(refs, opp.revealedMoves, animate);
  updateAbilities(refs, opp);
}

function updateMoves(refs, moves, animate) {
  const names = moves.map((m) => m.name);
  const prev = refs.moveNames;
  const appendOnly = prev.length <= names.length && prev.every((n, i) => names[i] === n);

  if (!appendOnly) {
    // Not expected (moves only get added), but if the list ever differs, redraw the grid.
    refs.moveGrid.textContent = '';
    for (let i = 0; i < Math.max(MIN_MOVE_SLOTS, moves.length); i++) {
      refs.moveGrid.appendChild(i < moves.length ? revealedSlot(moves[i], false) : emptySlot());
    }
  } else if (prev.length < names.length || refs.moveGrid.childElementCount === 0) {
    // Only the newly revealed slots are created, so only they play the reveal animation.
    if (refs.moveGrid.childElementCount === 0) {
      for (let i = 0; i < MIN_MOVE_SLOTS; i++) refs.moveGrid.appendChild(emptySlot());
    }
    for (let i = prev.length; i < moves.length; i++) {
      const node = revealedSlot(moves[i], animate);
      const old = refs.moveGrid.children[i];
      if (old) refs.moveGrid.replaceChild(node, old);
      else refs.moveGrid.appendChild(node);
    }
  }
  refs.moveNames = names;
}

function updateAbilities(refs, opp) {
  const key = (opp.revealedAbility || '') + '|' + opp.possibleAbilities.map((a) => a.name).join(',');
  if (key === refs.abilityKey) return;
  refs.abilityKey = key;

  const list = refs.abilityList;
  list.textContent = '';
  const revealedId = opp.revealedAbility ? toId(opp.revealedAbility) : null;
  let matched = false;

  for (const a of opp.possibleAbilities) {
    const isRevealed = revealedId !== null && toId(a.name) === revealedId;
    if (isRevealed) matched = true;
    const pill = el('span', 'ability-pill' + (isRevealed ? ' ability-revealed' : (revealedId ? ' ability-dim' : '')));
    pill.appendChild(el('span', 'ability-name', a.name));
    if (isRevealed) pill.appendChild(el('span', 'ability-tag', 'revealed'));
    attachTip(pill, () => [{ cls: 'tip-title', text: a.name }, { cls: 'tip-desc', text: a.shortDesc || 'No description.' }]);
    list.appendChild(pill);
  }

  // Revealed but not in the species list (Trace, Skill Swap...): still show it.
  if (revealedId !== null && !matched) {
    const pill = el('span', 'ability-pill ability-revealed');
    pill.appendChild(el('span', 'ability-name', opp.revealedAbility));
    pill.appendChild(el('span', 'ability-tag', 'revealed'));
    attachTip(pill, () => [{ cls: 'tip-title', text: opp.revealedAbility }, { cls: 'tip-desc', text: 'Revealed in this battle.' }]);
    list.appendChild(pill);
  }

  refs.abilitySec.hidden = list.childElementCount === 0;
}

// ---------------------------------------------------------------------------
// "You" block (compact: name, types, Tera, weaknesses only)
// ---------------------------------------------------------------------------

function fillMe(box, me) {
  box.textContent = '';
  const head = el('div', 'me-head');
  head.appendChild(el('span', 'live-side', 'You'));
  head.appendChild(el('span', 'live-name', me.species || me.name || '?'));
  for (const t of me.types) head.appendChild(chip(t));
  if (me.terastallized) head.appendChild(el('span', 'tera-badge', 'Tera'));
  box.appendChild(head);
  if (me.types.length === 0) {
    box.appendChild(el('div', 'live-muted', 'Types not available for this Pokémon.'));
    return;
  }
  const fx = el('div', 'me-effects');
  fillEffects(fx, me);
  if (!fx.hidden) box.appendChild(fx);
  const r = row('Weak to', weakChips(me));
  if (r) box.appendChild(r);
}

// ---------------------------------------------------------------------------
// Field strip: weather, terrain and the screens on each side (from the log)
// ---------------------------------------------------------------------------

function fieldChip(fx) {
  // "Spikes x2" for stacked hazards; every other entry has one layer and shows just its name.
  const text = fx.layers > 1 ? fx.name + ' x' + fx.layers : fx.name;
  return effectChip(text, 'effect-field', fx.shortDesc ? [{ cls: 'tip-title', text: fx.name }, { cls: 'tip-desc', text: fx.shortDesc }] : null);
}

function renderField(box, field) {
  box.textContent = '';
  const rows = [
    row('Field', [field.weather, field.terrain].filter(Boolean).map(fieldChip)),
    row('Your side', field.mySide.map(fieldChip)),
    row('Their side', field.oppSide.map(fieldChip)),
  ];
  for (const r of rows) if (r) box.appendChild(r);
  box.hidden = box.childElementCount === 0;
}

// ---------------------------------------------------------------------------
// Whole-section state and entry point
// ---------------------------------------------------------------------------

// view holds the DOM we built and what it currently shows. null = nothing built.
let view = null;

// The roster: one tile per opponent Pokémon seen so far (+ "?" tiles for the rest of the
// team). Clicking a seen tile shows that Pokémon in the card below instead of the active one.
// Rebuilt only when its content changes (cheap, and it has no animation to replay).
function renderRoster(info) {
  const team = info.opponentTeam || [];
  const unseen = info.unseenCount || 0;
  const key = JSON.stringify([team.map((m) => [m.name, m.species, m.types, m.active, m.fainted]), unseen, view.selected]);
  if (key === view.rosterKey) return;
  view.rosterKey = key;

  // A rebuild would drop keyboard focus from the tile that was just pressed; put it back.
  const focused = document.activeElement && document.activeElement._rosterName;
  const box = view.rosterBox;
  box.textContent = '';
  if (team.length === 0 && unseen === 0) return;

  box.appendChild(el('div', 'sec-title', 'Opponent’s team'));
  const grid = el('div', 'roster-grid');
  for (const m of team) {
    const tile = el('button', 'roster-tile'
      + (m.active ? ' is-active' : '') + (m.fainted ? ' is-fainted' : '') + (view.selected === m.name ? ' is-selected' : ''));
    tile.type = 'button';
    tile._rosterName = m.name;
    tile.appendChild(el('span', 'tile-name', m.species || m.name));
    const dots = el('span', 'tile-types');
    for (const t of m.types) dots.appendChild(el('span', 'tile-dot ' + typeClass(t)));
    tile.appendChild(dots);
    tile.setAttribute('aria-label', (m.species || m.name) + (m.active ? ', on the field' : '') + (m.fainted ? ', fainted' : ''));
    tile.setAttribute('aria-pressed', String(view.selected === m.name));
    tile.addEventListener('click', () => {
      // The active Pokémon already has the card; a second click on a selected one goes back.
      view.selected = (m.active || view.selected === m.name) ? null : m.name;
      update(view.info);
    });
    grid.appendChild(tile);
    if (focused === m.name) tile.focus();
  }
  for (let i = 0; i < unseen; i++) {
    // Nothing is known about these, so nothing is shown: no name, no types.
    const t = el('span', 'roster-tile is-unseen', '?');
    t.setAttribute('aria-label', 'Not seen yet');
    grid.appendChild(t);
  }
  box.appendChild(grid);
}

function ensureShell() {
  if (view) return;
  liveEl.textContent = '';
  const header = el('div', 'live-header');
  header.appendChild(el('span', 'turn-pill'));
  header.appendChild(el('span', 'live-title', 'Revealed info only'));

  const fieldBox = el('div', 'field-strip');
  fieldBox.hidden = true;
  const rosterBox = el('div', 'roster');

  // Shown only while a Pokémon other than the active one is displayed.
  const viewBar = el('div', 'view-bar');
  viewBar.hidden = true;
  const viewText = el('span', 'view-text');
  const backBtn = el('button', 'view-back', 'Back to active');
  backBtn.type = 'button';
  backBtn.addEventListener('click', () => { view.selected = null; update(view.info); });
  viewBar.appendChild(viewText);
  viewBar.appendChild(backBtn);

  const oppBox = el('div', 'opp-slot');
  const meBox = el('div', 'live-block me-block');
  liveEl.appendChild(header);
  liveEl.appendChild(fieldBox);
  liveEl.appendChild(rosterBox);
  liveEl.appendChild(viewBar);
  liveEl.appendChild(oppBox);
  liveEl.appendChild(meBox);
  view = {
    turnPill: header.firstChild, fieldBox, fieldKey: null, rosterBox, viewBar, viewText, oppBox, meBox,
    opp: null, meKey: null, rosterKey: null,
    selected: null, // name of the roster Pokémon being viewed, null = the active one
    lastActive: null, info: null,
  };
}

function update(info) {
  ensureShell();
  view.info = info; // click handlers re-render from this
  view.turnPill.textContent = 'Turn ' + info.turn;

  const fieldKey = JSON.stringify(info.field || null);
  if (fieldKey !== view.fieldKey) {
    view.fieldKey = fieldKey;
    if (info.field) renderField(view.fieldBox, info.field);
    else view.fieldBox.hidden = true;
  }

  // The opponent sent out a different Pokémon: jump back to showing the active one.
  const activeName = info.opponent ? info.opponent.name : null;
  if (activeName !== view.lastActive) { view.selected = null; view.lastActive = activeName; }

  // Which Pokémon does the card show: the active one, or a bench/fainted one the user picked?
  let shown = info.opponent;
  let viewing = null;
  if (view.selected) {
    viewing = (info.opponentTeam || []).find((m) => m.name === view.selected && !m.active) || null;
    if (viewing) shown = viewing; else view.selected = null;
  }
  renderRoster(info);
  view.viewBar.hidden = !viewing;
  if (viewing) {
    view.viewText.textContent = 'Viewing ' + (viewing.species || viewing.name) + (viewing.fainted ? ' (fainted)' : ' (not on the field)');
  }

  if (!shown) {
    view.opp = null;
    view.oppBox.textContent = '';
    view.oppBox.appendChild(el('div', 'live-muted', 'No opposing Pokémon on the field.'));
  } else {
    const key = shown.name + '|' + shown.species;
    if (view.opp && view.opp.key === key) {
      updateOpponent(view.opp, shown, true);
    } else {
      // A different Pokémon: new card, which fades in and grows its stat bars.
      hideTip();
      view.oppBox.textContent = '';
      view.opp = buildOpponent(shown);
      view.oppBox.appendChild(view.opp.card);
    }
  }

  const meKey = info.me ? JSON.stringify(info.me) : '';
  if (meKey !== view.meKey) {
    view.meKey = meKey;
    view.meBox.textContent = '';
    if (info.me) fillMe(view.meBox, info.me);
  }
}

// data is { room, info }. info === null means "nothing to show / clear".
window.panelAPI.onLiveInfo(({ info }) => {
  try {
    const inBattle = !!info && info.ended === false;
    // One class on <body> decides what is visible (two rules in panel.html).
    document.body.classList.toggle('in-battle', inBattle);
    if (!inBattle) {
      // Forget the card so the next battle starts with a fresh fade-in even if the first
      // opponent happens to be the same species.
      hideTip();
      liveEl.textContent = '';
      view = null;
      return;
    }
    update(info);
  } catch (err) {
    // A display bug must never break the rest of the panel.
    liveEl.textContent = '';
    view = null;
    console.error('[panel-live] render failed:', err.message);
  }
});
})();
