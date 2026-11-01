// parser.js: line-level parsing of Showdown's battle protocol. Pure: strings in, data out.
// (No electron, fs or network, so it can be tested with plain Node on saved logs.)

// Lines that carry no battle information. Showdown sends these between real events.
const NOISE = new Set(['t:', 'inactive', 'inactiveoff', 'raw', 'c', 'c:', 'chat', 'html', 'uhtml', 'uhtmlchange']);

// "|move|p1a: X|Tackle|p2a: Y|[miss]" -> { cmd: 'move', args: ['p1a: X','Tackle','p2a: Y'], kw: { miss: true } }
// Trailing "[key] value" / "[key]" segments are pulled out into kw, because they are
// modifiers ("[from] item: Life Orb", "[of] p1a: X") and would otherwise shift the
// positions of the normal arguments.
// Returns null for blank and noise lines.
function parseLine(line) {
  if (!line || line[0] !== '|') return null;
  const rest = line.slice(1);
  const cmd = rest.split('|', 1)[0];
  if (cmd === '' || NOISE.has(cmd)) return null;

  // The request is one big JSON blob. Never split it on "|": a move or item name could
  // in principle contain one, and we want the JSON in a single piece.
  if (cmd === 'request') {
    const json = rest.slice('request|'.length);
    if (!json) return null;
    try {
      return { cmd, args: [JSON.parse(json)], kw: {} };
    } catch {
      return null; // a damaged request is skipped, not fatal
    }
  }

  const parts = rest.split('|').slice(1);
  const kw = {};
  while (parts.length > 0) {
    const m = /^\[(\w+)\]\s*(.*)$/.exec(parts[parts.length - 1]);
    if (!m) break;
    kw[m[1]] = m[2] === '' ? true : m[2];
    parts.pop();
  }
  return { cmd, args: parts, kw };
}

// "p1a: Vigoroth" -> { side: 'p1', slot: 'a', name: 'Vigoroth' }. Also "p1: cool213"
// (side events have no slot). Names can contain spaces and colons, so only the FIRST
// ": " is a separator.
function parseIdent(ident) {
  const m = /^(p\d)([a-z]?): (.*)$/.exec(ident || '');
  if (!m) return null;
  return { side: m[1], slot: m[2] || null, name: m[3] };
}

// "Slither Wing, L81, M, tera:Ghost" -> { species, level, gender, tera }.
// Level is 100 when omitted (Showdown leaves it out at level 100). The species is the
// text before the first ", L..." / ", M" / ", F" part, so names with commas do not occur
// in practice but names with spaces and hyphens do (never split on spaces).
function parseDetails(details) {
  const parts = (details || '').split(', ');
  const out = { species: parts[0], level: 100, gender: null, tera: null };
  for (const p of parts.slice(1)) {
    if (/^L\d+$/.test(p)) out.level = Number(p.slice(1));
    else if (p === 'M' || p === 'F') out.gender = p;
    else if (p.startsWith('tera:')) out.tera = p.slice(5);
  }
  return out;
}

// "266/266", "85/100", "120/266 par", "0 fnt" -> { hp, maxHp, status, fainted }.
// maxHp is null for "0 fnt" (Showdown drops it); the caller keeps the old maxHp.
function parseCondition(condition) {
  const [hpPart, status = null] = (condition || '').trim().split(' ');
  if (status === 'fnt' || hpPart === '0') {
    return { hp: 0, maxHp: null, status: null, fainted: true };
  }
  const [hp, maxHp] = hpPart.split('/').map(Number);
  if (!Number.isFinite(hp) || !Number.isFinite(maxHp)) return null;
  return { hp, maxHp, status, fainted: false };
}

// Names in |j| / |l| / |win| can carry a rank symbol prefix ("☆cool213", "‽name").
// Strip it before comparing names. Only strips non-name symbols, never letters or digits.
function stripRank(name) {
  return (name || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

module.exports = { parseLine, parseIdent, parseDetails, parseCondition, stripRank };
