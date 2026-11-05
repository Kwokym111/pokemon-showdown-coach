// panel-review.js: the #review section of the panel. Kym's file.
// It only displays what main sends (the same review object the popup card gets), so the
// review stays visible here after the popup is closed.
// The drawing code is a copy of overlay/overlay.js on purpose: the two pages are separate
// and have no bundler to share code through. If you change one, change the other, or
// delete the popup later and this becomes the only copy.
// Everything uses createElement + textContent, never innerHTML: names come from the server.

const LABELS = ['great', 'good', 'mistake', 'blunder'];
const LABEL_WORDS = { great: 'Great', good: 'Good', mistake: 'Mistake', blunder: 'Blunder' };
const COUNT_WORDS = { great: 'Great', good: 'Good', mistake: 'Mistakes', blunder: 'Blunders' };

const reviewEl = document.getElementById('review');

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function headlineText(review) {
  const vs = review.players && review.players.opponent ? ` vs ${review.players.opponent}` : '';
  let text = 'Game over';
  if (review.result.won === true) text = `You won${vs}`;
  else if (review.result.won === false) text = `You lost${vs}`;
  return review.result.forfeit ? `${text} (forfeit)` : text;
}

function countsText(moments) {
  return LABELS.map((label) => `${moments.filter((m) => m.label === label).length} ${COUNT_WORDS[label]}`)
    .join(' · ');
}

// The review format says the screen must not depend on `facts`, so it is only a fallback.
function detailText(moment) {
  if (typeof moment.explanation === 'string') return moment.explanation;
  if (moment.facts && typeof moment.facts.whyKnowable === 'string') return moment.facts.whyKnowable;
  return null;
}

// The 18 types, lower case. A type from the data is only ever used as a CSS class if it is in
// this list, so nothing from the server can pick an arbitrary class name.
const TYPES = ['normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground',
  'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'];

function typeClass(type) {
  const t = typeof type === 'string' ? type.toLowerCase() : '';
  return `type-${TYPES.includes(t) ? t : 'unknown'}`;
}

// "Zekrom 100% · Dodrio 62% · Gardevoir 30% PAR". HP is rounded: own HP% can be 24.6.
function benchText(bench) {
  return bench.map((b) => {
    const hp = typeof b.hpPct === 'number' ? ` ${Math.round(b.hpPct)}%` : '';
    return `${b.name}${hp}${b.status ? ` ${String(b.status).toUpperCase()}` : ''}`;
  }).join(' · ');
}

function moveChip(m) {
  const dimmed = m.disabled || m.pp === 0;
  const chip = el('span', m.name, `opt-chip ${typeClass(m.type)}${m.used ? ' used' : ''}${dimmed ? ' dim' : ''}`);
  // The mark is text as well as an outline, so it does not rely on colour.
  if (m.used) chip.append(el('span', ' ✓ used', 'opt-used'));
  return chip;
}

// What I could have chosen on that decision (moment.options). Display only; null/missing -> nothing.
function optionsBlock(options) {
  if (!options || typeof options !== 'object') return null;
  const block = el('div', undefined, 'options');

  if (options.kind === 'turn' && Array.isArray(options.moves) && options.moves.length) {
    const row = el('div', undefined, 'opt-row');
    row.append(el('span', `Your moves${options.active ? ` (${options.active})` : ''}:`, 'opt-label'));
    for (const m of options.moves) row.append(moveChip(m));
    if (options.canTerastallize) row.append(el('span', `Tera: ${options.canTerastallize} available`, 'opt-tera'));
    block.append(row);
  }

  if (Array.isArray(options.bench) && options.bench.length) {
    const row = el('div', undefined, 'opt-row');
    row.append(el('span', options.kind === 'replacement' ? 'Could send in:' : 'Bench:', 'opt-label'),
      el('span', benchText(options.bench), 'opt-bench'));
    block.append(row);
  }
  return block.childNodes.length ? block : null;
}

function momentItem(moment) {
  const item = el('li', undefined, 'moment');

  const head = el('div', undefined, 'moment-head');
  head.append(
    el('span', `Turn ${moment.turn}`, 'turn'),
    // Unknown labels still get readable text, just no colour.
    el('span', LABEL_WORDS[moment.label] || String(moment.label), `badge ${LABELS.includes(moment.label) ? moment.label : ''}`),
  );
  item.append(head, el('p', `${moment.mon}: ${moment.title}`, 'moment-title'));

  const detail = detailText(moment);
  if (detail) item.append(el('p', detail, 'detail'));
  const opts = optionsBlock(moment.options);
  if (opts) item.append(opts);
  return item;
}

function render(data) {
  reviewEl.replaceChildren(); // a new review replaces the old one (and the placeholder)

  if (data.error) {
    reviewEl.append(el('h2', 'Game over'), el('p', 'Couldn\'t build the review for this game.', 'empty'));
    return;
  }
  if (data.spectated) {
    reviewEl.append(el('h2', 'Game over'),
      el('p', 'You were spectating this battle, so there\'s nothing to review.', 'empty'));
    return;
  }

  const turns = data.result.lastTurn;
  reviewEl.append(
    el('h2', headlineText(data)),
    el('p', `${turns} ${turns === 1 ? 'turn' : 'turns'}`, 'sub'),
    el('p', countsText(data.moments), 'counts'),
  );
  // Written by the AI; null until it arrives (or when it is unavailable).
  if (typeof data.summary === 'string' && data.summary) reviewEl.append(el('p', data.summary, 'summary'));

  if (data.moments.length === 0) {
    reviewEl.append(el('p', 'No key moments in this game. The coach only flags moments it\'s confident about.', 'empty'));
    if (data.result.forfeit && turns <= 5) reviewEl.append(el('p', 'Short game: not much to review.', 'empty'));
    return;
  }

  const list = el('ul', undefined, 'moments');
  // Moments already come in turn order from buildReview; sorting again is cheap insurance.
  for (const m of [...data.moments].sort((a, b) => a.turn - b.turn)) list.append(momentItem(m));
  reviewEl.append(list);
}

// Whether the AI text is on its way. render() wipes the line, so a finished review
// (which replaces everything) clears it automatically.
function showAiStatus(state) {
  const counts = reviewEl.querySelector('.counts');
  if (!counts) return; // an error/spectated review has nothing to attach it to
  let line = reviewEl.querySelector('.ai-status');
  if (!line) {
    line = el('p', undefined, 'ai-status');
    counts.after(line);
  }
  if (state === 'pending') line.textContent = 'Writing explanations…';
  else if (state === 'unavailable') line.textContent = 'AI explanations unavailable, showing the facts only.';
  else line.textContent = '';
}

window.panelAPI.onReview(render);
window.panelAPI.onReviewAiStatus(showAiStatus);
