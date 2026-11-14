// Outfit picking without Claude: a simple rule-based matcher used when there's no API key
// (or no connection). It matches dress code and season, prefers pieces not worn lately and
// varies the picks between suggestions. Claude does a much better job with colour and style.

// Dress-code range [min, max] on the 1-5 scale for common occasions (matched by keyword).
const RANGES = [
  [/gym|active|sport|run|yoga|hike/i, [1, 1]],
  [/lounge|home|sofa/i, [1, 1]],
  [/beach|pool|holiday/i, [1, 2]],
  [/errand|weekend|school run|shopping/i, [1, 2]],
  [/travel|flight|airport/i, [1, 3]],
  [/brunch|picnic|coffee/i, [2, 3]],
  [/friends|casual dinner|drinks|pub/i, [2, 4]],
  [/date/i, [3, 4]],
  [/smart casual/i, [3, 3]],
  [/work|office/i, [3, 4]],
  [/business|meeting|client|interview|presentation/i, [4, 5]],
  [/formal|gala|black tie|cocktail|wedding|ceremony|church|temple|funeral|party/i, [4, 5]],
];

export function occasionRange(occasion) {
  // Later, dressier patterns win (so "formal dinner" beats "dinner").
  let range = [2, 4];
  for (const [re, r] of RANGES) if (re.test(occasion)) range = r;
  return range;
}

/** Rough job of an item in an outfit, from its category and type. */
export function roleOf(item) {
  const s = `${item.category} ${item.subtype}`.toLowerCase();
  if (/dress|jumpsuit|playsuit|romper/.test(s)) return 'onepiece';
  if (/shoe|boot|trainer|sneaker|heel|sandal|loafer|flat|footwear/.test(s)) return 'shoes';
  if (/bag|tote|clutch|backpack|purse/.test(s)) return 'bag';
  if (/outer|coat|jacket|blazer|cardigan|parka|trench/.test(s)) return 'outer';
  if (/active|gym|sport|legging/.test(s)) return 'active';
  if (/bottom|trouser|pant|jean|skirt|short|chino/.test(s)) return 'bottom';
  if (/top|shirt|blouse|tee|t-shirt|knit|jumper|sweater|polo|vest|cami/.test(s)) return 'top';
  if (/access|jewel|scarf|belt|hat|cap|watch|sunglass|tie|earring|necklace|bracelet/.test(s)) return 'acc';
  return 'other';
}

const daysSince = (date, today) => (date ? (new Date(today) - new Date(date)) / 86_400_000 : 999);

/**
 * @returns {{ outfits: [{ title, itemIds, why, tip }], gap: string }}
 */
export function fallbackOutfits({ items, anchorIds, occasion, weather, today, count = 3 }) {
  const [lo, hi] = occasionRange(occasion);
  const cold = /cold|cool|rain/i.test(weather);
  const hot = /hot|warm/i.test(weather);
  const anchors = anchorIds.map((id) => items.find((i) => i.id === id)).filter(Boolean);
  const byRole = new Map();
  for (const it of items) {
    if (anchorIds.includes(it.id)) continue;
    const r = roleOf(it);
    if (!byRole.has(r)) byRole.set(r, []);
    byRole.get(r).push(it);
  }
  const used = new Map(); // id -> times used in earlier suggestions

  const score = (it) => {
    const f = it.formality || 3;
    let s = f < lo ? (lo - f) * 3 : f > hi ? (f - hi) * 3 : 0;
    if (cold && it.season === 'Warm weather') s += 2;
    if (hot && (it.season === 'Cold weather' || it.season === 'Cool weather')) s += 2;
    if (daysSince(it.lastWorn, today) < 7) s += 1;
    s += (used.get(it.id) || 0) * 1.5;
    return s + Math.random() * 1.2;
  };
  const pick = (role) => {
    const list = byRole.get(role) || [];
    if (!list.length) return null;
    return list.map((it) => [score(it), it]).sort((a, b) => a[0] - b[0])[0][1];
  };

  const outfits = [];
  for (let k = 0; k < count; k++) {
    const chosen = [...anchors];
    const has = (role) => chosen.some((i) => roleOf(i) === role);
    const add = (role) => { const it = pick(role); if (it) chosen.push(it); };
    if (lo === 1 && hi === 1 && byRole.get('active')?.length && /gym|active|sport|run|yoga|hike/i.test(occasion)) {
      if (!has('active')) add('active');
    } else if (!has('onepiece') && !has('top') && !has('bottom')) {
      const dresses = byRole.get('onepiece')?.length;
      const separates = byRole.get('top')?.length && byRole.get('bottom')?.length;
      if (dresses && (!separates || k === 1)) add('onepiece');
      else { add('top'); add('bottom'); }
    } else if (!has('onepiece')) {
      if (!has('top')) add('top');
      if (!has('bottom')) add('bottom');
    }
    if (!has('shoes')) add('shoes');
    if ((cold || (lo >= 4 && k === 0)) && !has('outer')) add('outer');
    if (lo >= 2 && !has('bag')) add('bag');
    if (hi >= 3 && !has('acc') && Math.random() < 0.6) add('acc');
    for (const it of chosen) used.set(it.id, (used.get(it.id) || 0) + 1);
    const ids = [...new Set(chosen.map((i) => i.id))];
    if (ids.length && !outfits.some((o) => o.itemIds.join() === ids.join())) {
      outfits.push({
        title: `${occasion} · option ${outfits.length + 1}`,
        itemIds: ids,
        why: 'Picked to match the dress code and season. Add a Claude API key in Settings for real styling advice on colours and fit.',
        tip: '',
      });
    }
  }
  const missing = ['shoes', 'top', 'bottom'].filter((r) => !byRole.get(r)?.length && !anchors.some((a) => roleOf(a) === r));
  return { outfits, gap: missing.length ? `Add some ${missing.join(', ')} to your closet for fuller outfits.` : '' };
}
