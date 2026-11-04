// overlay.js: the end-of-game card's page script. It only displays what main sends it.
// Everything is built with createElement + textContent, never innerHTML: names and titles
// come from the server, and innerHTML would run any HTML hiding in them.

const LABELS = ['great', 'good', 'mistake', 'blunder'];
const LABEL_WORDS = { great: 'Great', good: 'Good', mistake: 'Mistake', blunder: 'Blunder' };
const COUNT_WORDS = { great: 'Great', good: 'Good', mistake: 'Mistakes', blunder: 'Blunders' };

document.getElementById('close').addEventListener('click', () => window.review.close());

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
  return item;
}

function render(data) {
  const content = document.getElementById('content');
  content.replaceChildren(); // a second review replaces the first

  if (data.error) {
    content.append(el('h2', 'Game over'), el('p', 'Couldn\'t build the review for this game.', 'empty'));
    return;
  }
  if (data.spectated) {
    content.append(el('h2', 'Game over'),
      el('p', 'You were spectating this battle, so there\'s nothing to review.', 'empty'));
    return;
  }

  const turns = data.result.lastTurn;
  content.append(
    el('h2', headlineText(data)),
    el('p', `${turns} ${turns === 1 ? 'turn' : 'turns'}`, 'sub'),
    el('p', countsText(data.moments), 'counts'),
  );
  // Written by the AI; null until it arrives (or when it is unavailable).
  if (typeof data.summary === 'string' && data.summary) content.append(el('p', data.summary, 'summary'));

  if (data.moments.length === 0) {
    content.append(el('p', 'No key moments in this game. The coach only flags moments it\'s confident about.', 'empty'));
    if (data.result.forfeit && turns <= 5) content.append(el('p', 'Short game: not much to review.', 'empty'));
    return;
  }

  const list = el('ul');
  list.id = 'moments';
  // Moments already come in turn order from buildReview; sorting again is cheap insurance.
  for (const m of [...data.moments].sort((a, b) => a.turn - b.turn)) list.append(momentItem(m));
  content.append(list);
}

// Main tells us whether the AI text is on its way. render() wipes the line, so a finished
// review (which replaces the card) clears it automatically.
function showAiStatus(state) {
  const counts = document.querySelector('#content .counts');
  if (!counts) return; // an error/spectated card has nothing to attach it to
  let line = document.getElementById('ai-status');
  if (!line) {
    line = el('p', undefined, 'ai-status');
    line.id = 'ai-status';
    counts.after(line);
  }
  if (state === 'pending') line.textContent = 'Writing explanations…';
  else if (state === 'unavailable') line.textContent = 'AI explanations unavailable, showing the facts only.';
  else line.textContent = '';
}

window.review.onReview(render);
window.review.onAiStatus(showAiStatus);
