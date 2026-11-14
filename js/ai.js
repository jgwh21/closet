// Claude does two jobs here:
//   describeItem   looks at an item's photos (up to 4) and fills in the form
//   suggestOutfits picks complete outfits from your closet for an occasion
//
// The app calls the Claude API straight from the phone with your own API key, which is
// kept on this device only (never in backup files). Plain fetch is used rather than the
// Anthropic SDK because the app has no build step to bundle it with.

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';

export const MODELS = {
  'claude-haiku-5-5': 'Claude Haiku 5.5 (fastest, cheapest)',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 (better eye for style, costs more)',
};
export const DEFAULT_PHOTO_MODEL = 'claude-haiku-5-5';
export const DEFAULT_STYLE_MODEL = 'claude-sonnet-5-5';
// Server-side fallback (retry on another model if a request is declined) isn't offered on Haiku.
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5']);

export const SEASONS = ['All year', 'Warm weather', 'Cool weather', 'Cold weather'];
export const FORMALITY = ['', 'Very casual', 'Casual', 'Smart casual', 'Business / dressy', 'Formal'];

export class AiError extends Error {}

function explainHttp(status, body, what) {
  const msg = body?.error?.message || '';
  if (status === 401 || status === 403) return 'The Claude API key wasn\'t accepted. Check it in Settings.';
  if (status === 429) return 'Claude is busy or your usage limit was reached. Try again in a minute.';
  if (status === 400 && /credit|billing|balance/i.test(msg)) return 'Your Claude API account is out of credit. Top it up at console.anthropic.com.';
  if (status >= 500) return 'Claude is unavailable right now. Try again shortly.';
  return `Claude couldn't ${what} (${status}${msg ? `: ${msg}` : ''}).`;
}

async function call({ apiKey, model, effort, schema, system, content, what }) {
  if (!apiKey) throw new AiError('Add your Claude API key in Settings to use this.');
  const body = {
    model,
    max_tokens: 16000,
    output_config: { effort, format: { type: 'json_schema', schema } },
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content }],
  };
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    // Required for calls made from a browser. The key stays on this device; it is only ever
    // sent to api.anthropic.com.
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (FALLBACK_MODELS.has(model)) {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }

  let res;
  try {
    res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw new AiError('No connection to Claude. Try again when you\'re online.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new AiError(explainHttp(res.status, data, what));
  if (data.stop_reason === 'refusal') throw new AiError(`Claude declined to ${what}.`);
  if (data.stop_reason === 'max_tokens') throw new AiError('Claude\'s answer was cut short. Try again.');
  const text = data.content?.find((b) => b.type === 'text')?.text;
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError('Claude\'s answer couldn\'t be understood. Try again.');
  }
}

// ---------- describing an item from its photos ----------

function describeSchema(categories) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['readable', 'name', 'category', 'subtype', 'colours', 'pattern', 'material', 'brand', 'size', 'season', 'formality', 'description'],
    properties: {
      readable: { type: 'boolean', description: 'false if the photos show no clothing, shoes, bag or accessory' },
      name: { type: 'string', description: 'Short name a person would use, e.g. "Navy wool blazer", "Tan leather loafers"' },
      category: { type: 'string', enum: categories },
      subtype: { type: 'string', description: 'Garment type, e.g. Blouse, Jeans, Midi dress, Loafers, Tote, Belt' },
      colours: { type: 'string', description: 'Main colours, most dominant first, comma separated, e.g. "Navy, white"' },
      pattern: { type: 'string', description: 'e.g. Plain, Stripe, Floral, Check, Polka dot, Animal print, Logo' },
      material: { type: 'string', description: 'Fabric or material if visible on a label or obvious, else empty' },
      brand: { type: 'string', description: 'Brand only if readable on a label or logo, else empty' },
      size: { type: 'string', description: 'Size only if readable on a label, else empty' },
      season: { type: 'string', enum: SEASONS },
      formality: { type: 'integer', description: '1 very casual, 2 casual, 3 smart casual, 4 business / dressy, 5 formal' },
      description: { type: 'string', description: 'One sentence on cut, fit and style that helps match it into outfits, e.g. "Relaxed cropped fit, high waist; dresses up with heels or down with trainers"' },
    },
  };
}

/**
 * @param {string[]} imagesBase64  JPEGs, base64 without the data: prefix (1-4 photos of one item)
 * @param {{ apiKey: string, model: string, categories: string[] }} opts
 */
export async function describeItem(imagesBase64, { apiKey, model, categories }) {
  const content = [
    ...imagesBase64.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
    {
      type: 'text',
      text: `${imagesBase64.length > 1 ? `These ${imagesBase64.length} photos all show ONE item` : 'This photo shows one item'} (clothing, shoes, a bag or an accessory), taken to add it to a personal wardrobe inventory. Photos may include the front, back, a care label or a close-up.
Fill in the fields. Read brand, size and material from any label you can see; leave a field empty rather than guess.
For "category", pick the closest from the list.`,
    },
  ];
  const out = await call({ apiKey, model, effort: 'low', schema: describeSchema(categories), content, what: 'describe these photos' });
  if (!out.readable) throw new AiError('Claude couldn\'t see a clothing item in those photos. Try a clearer shot, or fill it in yourself.');
  out.formality = Math.min(5, Math.max(1, Math.round(Number(out.formality) || 3)));
  return out;
}

// ---------- styling outfits ----------

const STYLE_SYSTEM = `You are a friendly personal stylist with a sharp eye for colour, proportion and dress codes.
You put together complete outfits using ONLY the items in the person's wardrobe list. Each item has a reference like "i12"; use those references exactly.
A complete outfit is usually: a top and a bottom, or a dress/jumpsuit; plus shoes. Add outerwear when the weather calls for it, and a bag and accessories when they lift the look. Don't add two items that do the same job (two pairs of shoes, two bags).
Match the dress code of the occasion. Think about colour harmony, pattern mixing, balance of silhouette and season.
Give each outfit a short, fun title, one or two sentences on why it works, and one practical styling tip (how to wear, tuck, roll, layer or accessorise it).
If the wardrobe can't make a sensible outfit (for example no shoes at all), still do your best and say what's missing.
Use British English.`;

function styleSchema(refs) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['outfits', 'wardrobe_gap'],
    properties: {
      outfits: {
        type: 'array',
        description: 'Three distinct outfits, best first',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'items', 'why', 'styling_tip'],
          properties: {
            title: { type: 'string' },
            items: { type: 'array', items: { type: 'string', enum: refs } },
            why: { type: 'string' },
            styling_tip: { type: 'string' },
          },
        },
      },
      wardrobe_gap: { type: 'string', description: 'One piece that would give more options for this occasion, or empty if the wardrobe covers it well' },
    },
  };
}

function itemLine(ref, i) {
  const bits = [
    i.category, i.subtype, i.name, i.colours && `colours: ${i.colours}`, i.pattern && `pattern: ${i.pattern}`,
    i.material, `dress code ${i.formality || 3}/5 (${FORMALITY[i.formality || 3]})`, i.season,
    i.description, i.lastWorn && `last worn ${i.lastWorn}`,
  ].filter(Boolean);
  return `${ref}: ${bits.join(' | ')}`;
}

/**
 * @param {{ apiKey, model, occasion, weather, notes, today, items, anchorIds, recent }} opts
 *   items: the wardrobe to choose from (anchors included); recent: [{ date, names: [] }]
 * @returns {{ outfits: [{ title, itemIds, why, tip }], gap: string }}
 */
export async function suggestOutfits({ apiKey, model, occasion, weather, notes, today, items, anchorIds, recent }) {
  const refOf = new Map(items.map((it, n) => [it.id, `i${n + 1}`]));
  const idOf = new Map([...refOf].map(([id, ref]) => [ref, id]));
  const anchors = anchorIds.map((id) => items.find((i) => i.id === id)).filter(Boolean);
  const lines = [`Occasion: ${occasion}`, `Date: ${today}`];
  if (weather) lines.push(`Weather: ${weather}`);
  if (notes) lines.push(`Wishes: ${notes}`);
  if (anchors.length) {
    lines.push(`Every outfit MUST include: ${anchors.map((a) => `${refOf.get(a.id)} (${a.name})`).join(', ')}. Build around ${anchors.length > 1 ? 'these' : 'it'}.`);
  }
  if (recent.length) {
    lines.push(`Recently worn (avoid repeating the same combination):\n${recent.map((r) => `- ${r.date}: ${r.names.join(', ')}`).join('\n')}`);
  }
  lines.push('', `Wardrobe (${items.length} items):`, ...items.map((it) => itemLine(refOf.get(it.id), it)));
  const text = lines.join('\n');

  const out = await call({
    apiKey, model, effort: 'medium', system: STYLE_SYSTEM, schema: styleSchema([...idOf.keys()]),
    content: [{ type: 'text', text }], what: 'style an outfit',
  });
  const outfits = (out.outfits || []).map((o) => {
    const ids = [...new Set((o.items || []).map((r) => idOf.get(r)).filter(Boolean))];
    for (const a of anchors) if (!ids.includes(a.id)) ids.unshift(a.id); // the pieces you chose always stay in
    return { title: o.title || 'Outfit', itemIds: ids, why: o.why || '', tip: o.styling_tip || '' };
  }).filter((o) => o.itemIds.length);
  if (!outfits.length) throw new AiError('Claude couldn\'t put an outfit together from these items. Try adding more pieces, or a different occasion.');
  return { outfits, gap: out.wardrobe_gap || '' };
}
