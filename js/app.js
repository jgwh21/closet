import * as db from './db.js';
import { preparePhoto, blobToBase64 } from './images.js';
import {
  describeItem, suggestOutfits, AiError, MODELS, DEFAULT_PHOTO_MODEL, DEFAULT_STYLE_MODEL, SEASONS, FORMALITY,
} from './ai.js';
import { fallbackOutfits } from './stylist.js';
import { buildBackup, readBackup, mergeIntoMine, replaceMine, toCsv, toText, NotABackup } from './share.js';

// Must equal VERSION in sw.js and the app-version meta tag in index.html;
// `python build-upload.py --bump` updates all three, and the build refuses if they differ.
const APP_VERSION = 'closet-v1';

const $ = (id) => document.getElementById(id);
const MAX_PHOTOS = 4;

const DEFAULT_CATEGORIES = [
  'Tops', 'Bottoms', 'Dresses & jumpsuits', 'Outerwear', 'Shoes', 'Bags', 'Accessories', 'Jewellery',
  'Activewear', 'Sleep & loungewear', 'Other',
];
const DEFAULT_LOCATIONS = [
  'Wardrobe – hanging rail', 'Wardrobe – shelves', 'Drawer 1', 'Drawer 2', 'Drawer 3', 'Shoe rack', 'Shoe boxes',
  'Bag shelf', 'Accessory tray', 'Under-bed storage', 'Storage box – off season',
];
const DEFAULT_OCCASIONS = [
  'Normal work day', 'Business meeting', 'Formal dinner', 'Light casual brunch', 'Dinner night with friends',
  'Date night', 'Weekend errands', 'Cocktail party', 'Wedding guest', 'Job interview', 'Travel day',
  'Beach / holiday', 'Gym / active', 'Smart casual event', 'Religious ceremony', 'Lounging at home',
];
const STATUSES = ['In closet', 'In the laundry', 'At dry cleaner / tailor', 'Lent out', 'Packed / travelling', 'To donate / sell'];

const state = {
  settings: null,
  apiKey: '',
  items: [],
  looks: [],
  thumbUrls: new Map(), // photoId -> object URL
  sort: 'category',
  query: '',
  filterCategory: '',
  filterLocation: '',
  filterStatus: '',
  draft: null,  // { item, isNew, photos: [{ id, photo?, thumb? }], removed: [], touched: Set, aiToken }
  style: { occasion: '', anchors: [], results: null, token: 0 },
  picker: null, // Set of ids being chosen
};

// ---------- small helpers ----------

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const versionNumber = () => APP_VERSION.replace('closet-v', '');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function localDate(d = new Date()) {
  return new Date(d - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function fmtDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', ...(y !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  });
}

let toastTimer;
function toast(msg, ms = 3500, action = null) {
  const t = $('toast');
  $('toast-text').textContent = msg;
  const btn = $('toast-action');
  btn.hidden = !action;
  btn.onclick = null;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => { t.hidden = true; action.run(); };
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/** Shows a question with buttons; resolves with the chosen option's value (null if dismissed). */
function choose(title, text, options) {
  const dlg = $('chooser');
  $('chooser-title').textContent = title;
  $('chooser-text').textContent = text;
  const box = $('chooser-options');
  box.replaceChildren();
  return new Promise((resolve) => {
    for (const o of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn block ${o.style || ''}`;
      b.textContent = o.label;
      b.onclick = () => { dlg.close(); resolve(o.value); };
      box.append(b);
    }
    dlg.oncancel = () => resolve(null);
    dlg.showModal();
  });
}

function openSheet(dlg) {
  dlg.showModal();
  dlg.querySelector('.sheet-body')?.scrollTo(0, 0);
}

for (const dlg of document.querySelectorAll('dialog.sheet')) {
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) dlg.close();
  });
}

/** Saves a file through the share sheet where available (iPhone/Android), otherwise downloads it. */
async function deliverFile(blob, name, title) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  return true;
}

const fileSafe = (s) => s.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Closet';

function pick(input) {
  input.value = '';
  input.click();
}

// ---------- data ----------

async function loadSettings() {
  const saved = await db.get('meta', 'settings');
  state.settings = {
    closetId: randomId(),
    owner: '',
    closetName: '',
    categories: DEFAULT_CATEGORIES,
    locations: DEFAULT_LOCATIONS,
    occasions: DEFAULT_OCCASIONS,
    autoDescribe: true,
    photoModel: DEFAULT_PHOTO_MODEL,
    styleModel: DEFAULT_STYLE_MODEL,
    lastLocation: '',
    lastCategory: '',
    ...saved,
  };
  if (!saved) await saveSettings();
  if (!MODELS[state.settings.photoModel]) state.settings.photoModel = DEFAULT_PHOTO_MODEL;
  if (!MODELS[state.settings.styleModel]) state.settings.styleModel = DEFAULT_STYLE_MODEL;
  state.apiKey = (await db.get('meta', 'apiKey')) || '';
}

const saveSettings = () => db.set('meta', 'settings', state.settings);

function closetTitle() {
  const s = state.settings;
  return s.closetName || (s.owner ? `${s.owner}'s Closet` : 'My Closet');
}

async function loadData() {
  state.items = await db.getAll('items');
  state.looks = (await db.getAll('looks')).sort((a, b) => (b.saved || '').localeCompare(a.saved || ''));
}

const itemById = (id) => state.items.find((i) => i.id === id);

async function photoUrl(photoId) {
  if (!photoId) return '';
  if (state.thumbUrls.has(photoId)) return state.thumbUrls.get(photoId);
  const blob = await db.get('thumbs', photoId);
  const url = blob ? URL.createObjectURL(blob) : '';
  state.thumbUrls.set(photoId, url);
  return url;
}

function forgetPhoto(photoId) {
  const url = state.thumbUrls.get(photoId);
  if (url) URL.revokeObjectURL(url);
  state.thumbUrls.delete(photoId);
}

/** Fills every [data-photo] element inside root with its thumbnail. */
async function fillPhotos(root, isCurrent = () => true) {
  for (const el of root.querySelectorAll('[data-photo]')) {
    const url = await photoUrl(el.dataset.photo);
    if (!isCurrent()) return;
    el.style.backgroundImage = url ? `url("${url}")` : '';
    el.classList.toggle('none', !url);
  }
}

// ---------- closet grid ----------

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const rank = (list, v) => { const i = list.indexOf(v); return i < 0 ? list.length : i; };
const firstColour = (i) => (i.colours || '').split(/[,/&]| and /i)[0].trim() || 'No colour';

function sorted(items) {
  const byName = (a, b) => collator.compare(a.name, b.name);
  const s = state.settings;
  const fns = {
    name: byName,
    category: (a, b) => rank(s.categories, a.category) - rank(s.categories, b.category) || collator.compare(a.category, b.category) || byName(a, b),
    location: (a, b) => rank(s.locations, a.location) - rank(s.locations, b.location) || collator.compare(a.location, b.location) || byName(a, b),
    colour: (a, b) => collator.compare(firstColour(a), firstColour(b)) || byName(a, b),
    status: (a, b) => rank(STATUSES, a.status) - rank(STATUSES, b.status) || byName(a, b),
    'least-worn': (a, b) => (a.wornCount || 0) - (b.wornCount || 0) || (a.lastWorn || '').localeCompare(b.lastWorn || '') || byName(a, b),
    added: (a, b) => (b.added || '').localeCompare(a.added || ''),
  };
  return [...items].sort(fns[state.sort] || byName);
}

function groupOf(item) {
  switch (state.sort) {
    case 'category': return item.category || 'No category';
    case 'location': return item.location || 'No location';
    case 'colour': return firstColour(item).replace(/^./, (c) => c.toUpperCase());
    case 'status': return item.status || 'In closet';
    case 'least-worn': return item.wornCount ? 'Worn' : 'Never worn (in this app)';
    default: return null;
  }
}

function matches(item, query = state.query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return [item.name, item.brand, item.notes, item.category, item.subtype, item.colours, item.pattern, item.material, item.location, item.description]
    .some((v) => v?.toLowerCase().includes(q));
}

function shownItems() {
  return state.items.filter((i) => (!state.filterCategory || i.category === state.filterCategory)
    && (!state.filterLocation || i.location === state.filterLocation)
    && (!state.filterStatus || i.status === state.filterStatus)
    && matches(i));
}

function cardHtml(item, { selected = false, showStatus = true } = {}) {
  const sub = [item.colours, item.location].filter(Boolean).join(' · ');
  const n = (item.photos || []).length;
  return `
    <button class="card${selected ? ' selected' : ''}" type="button" data-id="${esc(item.id)}">
      <span class="card-img${n ? '' : ' none'}" ${n ? `data-photo="${esc(item.photos[0])}"` : ''}>${n ? '' : 'No photo'}</span>
      <span class="card-name">${esc(item.name)}</span>
      ${sub ? `<span class="card-sub">${esc(sub)}</span>` : ''}
      ${showStatus && item.status && item.status !== 'In closet' ? `<span class="badge">${esc(item.status)}</span>` : ''}
      ${n > 1 && !selected ? `<span class="photo-count">${n}</span>` : ''}
    </button>`;
}

function fillFilter(select, label, values, current) {
  select.innerHTML = [`<option value="">${label}</option>`,
    ...values.map((v) => `<option${v === current ? ' selected' : ''}>${esc(v)}</option>`)].join('');
}

let renderToken = 0;
async function render() {
  const token = ++renderToken;
  const s = state.settings;
  document.title = closetTitle();
  $('closet-title').textContent = closetTitle();

  const items = state.items;
  const away = items.filter((i) => i.status && i.status !== 'In closet').length;
  $('summary-line').textContent = `${plural(items.length, 'item')}${away ? ` · ${away} not in the closet` : ''}`;

  // Category chips with counts: the quickest way to see what you have of each kind.
  const counts = new Map();
  for (const i of items) counts.set(i.category, (counts.get(i.category) || 0) + 1);
  const cats = [...new Set([...s.categories, ...counts.keys()])].filter((c) => counts.get(c));
  if (state.filterCategory && !counts.get(state.filterCategory)) state.filterCategory = '';
  $('cat-chips').innerHTML = [
    `<button type="button" class="chip${state.filterCategory ? '' : ' on'}" data-cat="">All<span class="n">${items.length}</span></button>`,
    ...cats.map((c) => `<button type="button" class="chip${c === state.filterCategory ? ' on' : ''}" data-cat="${esc(c)}">${esc(c)}<span class="n">${counts.get(c)}</span></button>`),
  ].join('');
  $('cat-chips').hidden = !items.length;

  const locs = [...new Set([...s.locations, ...items.map((i) => i.location)])].filter((l) => l && items.some((i) => i.location === l));
  const stats = STATUSES.filter((st) => items.some((i) => i.status === st));
  if (state.filterLocation && !locs.includes(state.filterLocation)) state.filterLocation = '';
  if (state.filterStatus && !stats.includes(state.filterStatus)) state.filterStatus = '';
  fillFilter($('filter-location'), 'All locations', locs, state.filterLocation);
  fillFilter($('filter-status'), 'Any status', stats, state.filterStatus);

  const shown = sorted(shownItems());
  const empty = $('empty');
  empty.hidden = shown.length > 0;
  if (!items.length) {
    empty.innerHTML = '<p><strong>Your closet is empty.</strong></p><p class="muted">Tap <strong>Add item</strong> and photograph a piece: front, back and label. Claude can describe it for you (set it up in Settings). Then tap <strong>Style me</strong> for an outfit.</p>';
  } else if (!shown.length) {
    empty.innerHTML = '<p class="muted">Nothing matches.</p>';
  }

  const parts = [];
  let group;
  let open = false;
  for (const item of shown) {
    const g = groupOf(item);
    if (g !== group || !open) {
      if (open) parts.push('</div>');
      if (g !== null) parts.push(`<h3 class="group">${esc(g)}</h3>`);
      parts.push('<div class="grid">');
      open = true;
      group = g;
    }
    parts.push(cardHtml(item));
  }
  if (open) parts.push('</div>');
  $('list').innerHTML = parts.join('');
  await fillPhotos($('list'), () => token === renderToken);
}

$('list').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (card) openEditor(itemById(card.dataset.id));
});
$('cat-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-cat]');
  if (!chip) return;
  state.filterCategory = chip.dataset.cat;
  render();
});
$('search').addEventListener('input', (e) => { state.query = e.target.value.trim(); render(); });
$('sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  try { localStorage.setItem('sort', state.sort); } catch { /* private mode */ }
  render();
});
$('filter-location').addEventListener('change', (e) => { state.filterLocation = e.target.value; render(); });
$('filter-status').addEventListener('change', (e) => { state.filterStatus = e.target.value; render(); });

// ---------- adding and editing ----------

const FIELDS = ['name', 'category', 'subtype', 'colours', 'pattern', 'material', 'brand', 'size', 'season', 'formality', 'description', 'location', 'status', 'notes'];
const fieldEl = (f) => $(`f-${f}`);

function fillSelect(select, values, current) {
  const all = current && !values.includes(current) ? [...values, current] : values;
  select.innerHTML = all.map((v) => `<option${v === current ? ' selected' : ''}>${esc(v)}</option>`).join('');
}

function setFormality(v) {
  $('f-formality').value = v;
  $('formality-out').textContent = FORMALITY[v] || '';
}

function newItem() {
  const s = state.settings;
  return {
    id: randomId(), name: '', category: s.lastCategory || s.categories[0] || 'Other', subtype: '', colours: '', pattern: '',
    material: '', brand: '', size: '', season: 'All year', formality: 3, description: '',
    location: s.lastLocation || s.locations[0] || '', status: 'In closet', notes: '', photos: [], wornCount: 0, lastWorn: '',
  };
}

async function openEditor(item, files = null) {
  const isNew = !item;
  item ??= newItem();
  state.draft = { item, isNew, photos: (item.photos || []).map((id) => ({ id })), removed: [], touched: new Set(), aiToken: 0 };
  $('editor-title').textContent = isNew ? 'New item' : 'Edit item';
  fillSelect($('f-category'), state.settings.categories, item.category);
  fillSelect($('f-location'), state.settings.locations, item.location);
  fillSelect($('f-status'), STATUSES, item.status || 'In closet');
  fillSelect($('f-season'), SEASONS, item.season || 'All year');
  for (const f of FIELDS) {
    const el = fieldEl(f);
    el.classList.remove('ai-filled');
    if (f === 'formality') continue;
    el.value = item[f] ?? '';
  }
  setFormality(item.formality || 3);
  $('item-actions').hidden = isNew;
  $('worn-line').textContent = item.wornCount
    ? `Worn ${plural(item.wornCount, 'time')}${item.lastWorn ? `, last on ${fmtDate(item.lastWorn)}` : ''}.`
    : 'Not worn yet (in this app).';
  setAiStatus('');
  await renderStrip();
  openSheet($('editor'));
  if (files?.length) await addPhotos(files);
}

async function renderStrip() {
  const d = state.draft;
  const slots = [];
  for (let n = 0; n < MAX_PHOTOS; n++) {
    const p = d.photos[n];
    if (p) {
      slots.push(`<button type="button" class="slot" data-slot="${n}" aria-label="Photo ${n + 1}">
        ${n === 0 ? '<span class="cover">Cover</span>' : ''}
        <span class="x" data-remove="${n}" role="button" aria-label="Remove photo">×</span></button>`);
    } else {
      slots.push(`<button type="button" class="slot empty-slot" data-add="1">${n === d.photos.length ? '+ Add' : ''}</button>`);
    }
  }
  $('photo-strip').innerHTML = slots.join('');
  for (const [n, p] of d.photos.entries()) {
    const el = $('photo-strip').querySelector(`[data-slot="${n}"]`);
    const url = p.thumb ? (p.url ??= URL.createObjectURL(p.thumb)) : await photoUrl(p.id);
    if (url) el.style.backgroundImage = `url("${url}")`;
  }
  const full = d.photos.length >= MAX_PHOTOS;
  $('camera-btn').disabled = full;
  $('library-btn').disabled = full;
  $('camera-btn').textContent = d.photos.length ? 'Take another' : 'Take photo';
  $('describe-btn').hidden = !d.photos.length || !state.apiKey;
}

$('photo-strip').addEventListener('click', async (e) => {
  const d = state.draft;
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    const [p] = d.photos.splice(Number(rm.dataset.remove), 1);
    if (p.url) URL.revokeObjectURL(p.url);
    if (!p.thumb) d.removed.push(p.id);
    return renderStrip();
  }
  if (e.target.closest('[data-add]')) return pick($('camera-input'));
  const slot = e.target.closest('[data-slot]');
  if (!slot) return;
  const n = Number(slot.dataset.slot);
  const action = await choose(`Photo ${n + 1}`, '', [
    { label: 'View full size', value: 'view', style: 'primary' },
    ...(n > 0 ? [{ label: 'Make it the cover', value: 'cover' }] : []),
    { label: 'Cancel', value: null },
  ]);
  if (action === 'cover') {
    d.photos.unshift(...d.photos.splice(n, 1));
    renderStrip();
  } else if (action === 'view') {
    const p = d.photos[n];
    const blob = p.photo || (await db.get('photos', p.id));
    if (blob) showFullPhoto(blob, $('f-name').value || 'Photo');
  }
});

function showFullPhoto(blob, title) {
  const img = $('photo-full');
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(blob);
  $('photo-viewer-title').textContent = title;
  openSheet($('photo-viewer'));
}

async function addPhotos(files) {
  const d = state.draft;
  const room = MAX_PHOTOS - d.photos.length;
  const list = [...files].slice(0, room);
  if (files.length > room) toast(`Only ${MAX_PHOTOS} photos per item; kept the first ${room}.`);
  if (!list.length) return;
  setAiStatus('Preparing photos…', 'working');
  let added = 0;
  for (const file of list) {
    try {
      d.photos.push({ id: randomId(), ...(await preparePhoto(file)) });
      added++;
    } catch { /* skip unreadable files */ }
  }
  if (state.draft !== d) return;
  await renderStrip();
  if (!added) return setAiStatus('That photo couldn\'t be opened. Try taking it again.', 'error');
  // Describe automatically once, when the first photos go in; later photos can be read with the button.
  if (state.apiKey && state.settings.autoDescribe && d.isNew && !d.described) await describeDraft();
  else setAiStatus(state.apiKey ? '' : 'Tip: add a Claude API key in Settings and the details fill in by themselves.', '');
}

function setAiStatus(text, kind = '') {
  const el = $('ai-status');
  el.hidden = !text;
  el.textContent = text;
  el.className = `ai-status ${kind}`;
}

async function describeDraft() {
  const d = state.draft;
  if (!d.photos.length) return;
  d.described = true;
  const token = ++d.aiToken;
  setAiStatus(`Claude is looking at ${d.photos.length > 1 ? `the ${d.photos.length} photos` : 'the photo'}…`, 'working');
  $('describe-btn').disabled = true;
  try {
    const images = [];
    for (const p of d.photos) {
      const blob = p.photo || (await db.get('photos', p.id));
      if (blob) images.push(await blobToBase64(blob));
    }
    const out = await describeItem(images, { apiKey: state.apiKey, model: state.settings.photoModel, categories: state.settings.categories });
    if (state.draft !== d || token !== d.aiToken) return; // editor closed or a newer read started
    let filled = 0;
    for (const f of ['name', 'category', 'subtype', 'colours', 'pattern', 'material', 'brand', 'size', 'season', 'formality', 'description']) {
      const v = out[f];
      if (!v || d.touched.has(f)) continue; // never overwrite what you typed
      const el = fieldEl(f);
      if (f === 'formality') setFormality(v);
      else {
        if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === v)) continue;
        el.value = v;
      }
      el.classList.add('ai-filled');
      filled++;
    }
    setAiStatus(filled ? 'Filled in by Claude. Check it\'s right, then set where it lives.' : 'Claude found nothing new to fill in.', 'done');
  } catch (err) {
    if (state.draft !== d) return;
    setAiStatus(err instanceof AiError ? err.message : 'Something went wrong describing the photos.', 'error');
  } finally {
    $('describe-btn').disabled = false;
  }
}

$('item-form').addEventListener('input', (e) => {
  const f = FIELDS.find((x) => fieldEl(x) === e.target);
  if (f && state.draft) {
    state.draft.touched.add(f);
    e.target.classList.remove('ai-filled');
  }
});
$('f-formality').addEventListener('input', (e) => setFormality(Number(e.target.value)));

$('add-btn').addEventListener('click', () => openEditor(null));
$('camera-btn').addEventListener('click', () => pick($('camera-input')));
$('library-btn').addEventListener('click', () => pick($('library-input')));
$('describe-btn').addEventListener('click', describeDraft);

for (const id of ['camera-input', 'library-input']) {
  $(id).addEventListener('change', (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    if ($('editor').open && state.draft) addPhotos(files);
    else openEditor(null, files);
  });
}

function readForm(base) {
  const item = { ...base };
  for (const f of FIELDS) item[f] = f === 'formality' ? Number($('f-formality').value) : fieldEl(f).value.trim();
  return item;
}

$('item-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const d = state.draft;
  const item = readForm(d.item);
  if (!item.name) {
    $('f-name').focus();
    return toast('Give it a name first.');
  }
  item.photos = d.photos.map((p) => p.id);
  const now = new Date().toISOString();
  item.updated = now;
  if (d.isNew) item.added = now;
  const ops = [{ store: 'items', value: item }];
  for (const p of d.photos) {
    if (p.photo) ops.push({ store: 'photos', key: p.id, value: p.photo }, { store: 'thumbs', key: p.id, value: p.thumb });
  }
  for (const id of d.removed) {
    ops.push({ store: 'photos', key: id }, { store: 'thumbs', key: id });
    forgetPhoto(id);
  }
  try {
    await db.putMany(ops);
  } catch (err) {
    return toast(`Couldn't save: ${err.message}`, 6000);
  }
  const s = state.settings;
  if (item.location !== s.lastLocation || item.category !== s.lastCategory) {
    s.lastLocation = item.location;
    s.lastCategory = item.category;
    saveSettings();
  }
  navigator.storage?.persist?.().catch(() => {});
  closeEditor();
  await loadData();
  render();
  toast(d.isNew ? `Added ${item.name}` : 'Saved');
});

function closeEditor() {
  for (const p of state.draft?.photos || []) if (p.url) URL.revokeObjectURL(p.url);
  state.draft = null;
  if ($('editor').open) $('editor').close();
}
$('editor').addEventListener('close', () => { if (state.draft) closeEditor(); });

$('delete-btn').addEventListener('click', async () => {
  const { item } = state.draft;
  const ok = await choose(`Delete ${item.name}?`, 'Its photos are deleted too.', [
    { label: 'Delete', value: true, style: 'danger' }, { label: 'Cancel', value: false },
  ]);
  if (!ok) return;
  const photos = await Promise.all((item.photos || []).map(async (p) => [p, await db.get('photos', p), await db.get('thumbs', p)]));
  await db.putMany(db.deleteItemOps(item));
  closeEditor();
  await loadData();
  render();
  toast(`Deleted ${item.name}`, 6000, {
    label: 'Undo',
    run: async () => {
      await db.putMany([
        { store: 'items', value: item },
        ...photos.flatMap(([p, full, small]) => [
          ...(full ? [{ store: 'photos', key: p, value: full }] : []),
          ...(small ? [{ store: 'thumbs', key: p, value: small }] : []),
        ]),
      ]);
      await loadData();
      render();
    },
  });
});

/** Records that items were worn today. */
async function markWorn(ids) {
  const today = localDate();
  const ops = [];
  for (const id of ids) {
    const it = itemById(id);
    if (!it || it.lastWorn === today) continue;
    ops.push({ store: 'items', value: { ...it, wornCount: (it.wornCount || 0) + 1, lastWorn: today, updated: new Date().toISOString() } });
  }
  await db.putMany(ops);
  await loadData();
  render();
}

$('wore-btn').addEventListener('click', async () => {
  const { item } = state.draft;
  await markWorn([item.id]);
  closeEditor();
  toast(`${item.name}: worn today`);
});

$('style-this-btn').addEventListener('click', () => {
  const { item } = state.draft;
  closeEditor();
  openStylist([item.id]);
});

// ---------- outfit of the day ----------

function openStylist(anchors = []) {
  state.style.anchors = anchors;
  state.style.results = null;
  $('st-status').hidden = true;
  $('st-gap').hidden = true;
  $('st-results').innerHTML = '';
  renderOccasions();
  renderAnchors();
  renderLooks();
  openSheet($('stylist'));
}

$('style-btn').addEventListener('click', () => openStylist(state.style.anchors.filter(itemById)));

function renderOccasions() {
  $('occasion-chips').innerHTML = state.settings.occasions.map((o) => (
    `<button type="button" class="chip${o === state.style.occasion ? ' on' : ''}" data-occasion="${esc(o)}">${esc(o)}</button>`)).join('');
}

$('occasion-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-occasion]');
  if (!chip) return;
  state.style.occasion = state.style.occasion === chip.dataset.occasion ? '' : chip.dataset.occasion;
  $('st-custom').value = '';
  renderOccasions();
});
$('st-custom').addEventListener('input', () => {
  if ($('st-custom').value.trim() && state.style.occasion) {
    state.style.occasion = '';
    renderOccasions();
  }
});

async function renderAnchors() {
  const list = $('anchor-list');
  const items = state.style.anchors.map(itemById).filter(Boolean);
  list.innerHTML = items.map((i) => `
    <div class="anchor">
      <span class="mini" ${i.photos?.[0] ? `data-photo="${esc(i.photos[0])}"` : ''}></span>
      <span>${esc(i.name)}</span>
      <button type="button" data-unanchor="${esc(i.id)}" aria-label="Remove ${esc(i.name)}">×</button>
    </div>`).join('');
  list.hidden = !items.length;
  $('choose-anchors-btn').textContent = items.length ? 'Change pieces…' : 'Choose a top, bottom, shoes…';
  await fillPhotos(list);
}

$('anchor-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-unanchor]');
  if (!b) return;
  state.style.anchors = state.style.anchors.filter((id) => id !== b.dataset.unanchor);
  renderAnchors();
});

function occasionText() {
  return $('st-custom').value.trim() || state.style.occasion;
}

$('suggest-btn').addEventListener('click', async () => {
  const occasion = occasionText();
  if (!occasion) return toast('Pick an occasion first, or describe it.');
  const pool = $('st-pool').value === 'all' ? state.items : state.items.filter((i) => !i.status || i.status === 'In closet');
  const anchorIds = state.style.anchors.filter(itemById);
  const items = [...new Map([...pool, ...anchorIds.map(itemById)].map((i) => [i.id, i])).values()]
    .filter((i) => i.status !== 'To donate / sell' || anchorIds.includes(i.id));
  if (items.length < 2) return toast('Add a few more pieces to your closet first.');
  const weather = $('st-weather').value;
  const notes = $('st-notes').value.trim();
  const today = localDate();
  const token = ++state.style.token;
  const btn = $('suggest-btn');
  btn.disabled = true;
  $('st-results').innerHTML = '';
  $('st-gap').hidden = true;
  const status = $('st-status');
  status.hidden = false;

  let result;
  if (state.apiKey) {
    status.className = 'ai-status working';
    status.textContent = 'Claude is putting outfits together…';
    const cutoff = localDate(new Date(Date.now() - 14 * 86_400_000));
    const recent = state.looks.filter((l) => l.worn && l.date >= cutoff)
      .map((l) => ({ date: l.date, names: l.itemIds.map((id) => itemById(id)?.name).filter(Boolean) }));
    try {
      result = await suggestOutfits({
        apiKey: state.apiKey, model: state.settings.styleModel, occasion, weather, notes, today, items, anchorIds, recent,
      });
      status.hidden = true;
    } catch (err) {
      result = fallbackOutfits({ items, anchorIds, occasion, weather, today });
      status.className = 'ai-status error';
      status.textContent = `${err instanceof AiError ? err.message : 'Claude couldn\'t be reached.'} Showing simple matches instead.`;
    }
  } else {
    result = fallbackOutfits({ items, anchorIds, occasion, weather, today });
    status.className = 'ai-status';
    status.textContent = 'Simple matches by dress code. Add a Claude API key in Settings for real styling advice.';
  }
  btn.disabled = false;
  if (token !== state.style.token) return;
  state.style.results = result.outfits.map((o) => ({ ...o, occasion }));
  await renderResults();
  $('st-gap').hidden = !result.gap;
  $('st-gap').textContent = result.gap ? `Wardrobe idea: ${result.gap}` : '';
  $('st-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function lookHtml(look, { index, saved = false } = {}) {
  const items = look.itemIds.map(itemById);
  const pieces = items.map((i, n) => (i
    ? `<button type="button" class="look-item" data-open="${esc(i.id)}">
         <span class="mini" ${i.photos?.[0] ? `data-photo="${esc(i.photos[0])}"` : ''}></span><span>${esc(i.name)}</span></button>`
    : `<span class="look-item"><span class="mini"></span><span>Deleted item ${n + 1}</span></span>`)).join('');
  const when = saved
    ? `${look.worn ? 'Worn' : 'Saved'} ${fmtDate(look.date)} · ${esc(look.occasion)}`
    : esc(look.occasion);
  const actions = saved
    ? `<button type="button" class="btn small" data-wear-saved="${esc(look.id)}">Wear again today</button>
       <button type="button" class="btn small ghost danger-text" data-delete-look="${esc(look.id)}">Remove</button>`
    : `<button type="button" class="btn small primary" data-wear="${index}">Wear this today</button>
       <button type="button" class="btn small" data-save="${index}">Save look</button>`;
  return `
    <article class="look">
      <h4>${esc(look.title)}</h4>
      <p class="when">${when}</p>
      <div class="look-items">${pieces}</div>
      ${look.why ? `<p>${esc(look.why)}</p>` : ''}
      ${look.tip ? `<p class="tip">Tip: ${esc(look.tip)}</p>` : ''}
      <div class="look-actions">${actions}</div>
    </article>`;
}

async function renderResults() {
  const box = $('st-results');
  box.innerHTML = (state.style.results || []).map((look, index) => lookHtml(look, { index })).join('');
  await fillPhotos(box);
}

async function renderLooks() {
  const box = $('looks-list');
  box.innerHTML = state.looks.length
    ? state.looks.slice(0, 30).map((l) => lookHtml(l, { saved: true })).join('')
    : '<p class="hint">Looks you save or wear show here.</p>';
  await fillPhotos(box);
}

async function saveLook(look, worn) {
  const record = {
    id: randomId(), date: localDate(), saved: new Date().toISOString(), occasion: look.occasion,
    itemIds: look.itemIds, title: look.title, why: look.why, tip: look.tip, worn,
  };
  await db.set('looks', null, record);
  if (worn) await markWorn(look.itemIds);
  else await loadData();
  renderLooks();
}

$('stylist').addEventListener('click', async (e) => {
  const t = e.target;
  const open = t.closest('[data-open]');
  if (open) {
    const it = itemById(open.dataset.open);
    const blob = it?.photos?.[0] && (await db.get('photos', it.photos[0]));
    if (blob) showFullPhoto(blob, it.name);
    return;
  }
  const wear = t.closest('[data-wear]');
  const save = t.closest('[data-save]');
  if (wear || save) {
    const btn = wear || save;
    const look = state.style.results[Number(btn.dataset.wear ?? btn.dataset.save)];
    btn.disabled = true;
    await saveLook(look, !!wear);
    btn.textContent = wear ? 'Worn today ✓' : 'Saved ✓';
    return toast(wear ? 'Enjoy your day! Logged as worn.' : 'Look saved.');
  }
  const again = t.closest('[data-wear-saved]');
  if (again) {
    const look = state.looks.find((l) => l.id === again.dataset.wearSaved);
    await saveLook({ ...look, itemIds: look.itemIds.filter(itemById) }, true);
    return toast('Logged as worn today.');
  }
  const del = t.closest('[data-delete-look]');
  if (del) {
    await db.del('looks', del.dataset.deleteLook);
    await loadData();
    renderLooks();
  }
});

// ---------- choosing pieces to build around ----------

$('choose-anchors-btn').addEventListener('click', () => {
  state.picker = new Set(state.style.anchors);
  $('picker-search').value = '';
  const cats = [...new Set(state.items.map((i) => i.category))].sort((a, b) => rank(state.settings.categories, a) - rank(state.settings.categories, b));
  fillFilter($('picker-category'), 'All categories', cats, '');
  renderPicker();
  openSheet($('picker'));
});

let pickerToken = 0;
async function renderPicker() {
  const token = ++pickerToken;
  const q = $('picker-search').value.trim();
  const cat = $('picker-category').value;
  const items = sorted(state.items.filter((i) => (!cat || i.category === cat) && matches(i, q)));
  const grid = $('picker-grid');
  grid.innerHTML = items.length
    ? items.map((i) => cardHtml(i, { selected: state.picker.has(i.id) })).join('')
    : '<p class="hint">Nothing matches.</p>';
  await fillPhotos(grid, () => token === pickerToken);
}

$('picker-grid').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  state.picker.has(id) ? state.picker.delete(id) : state.picker.add(id);
  card.classList.toggle('selected', state.picker.has(id));
});
$('picker-search').addEventListener('input', renderPicker);
$('picker-category').addEventListener('change', renderPicker);
$('picker-done').addEventListener('click', () => {
  state.style.anchors = [...state.picker];
  $('picker').close();
  renderAnchors();
});

// ---------- export, backup, restore ----------

$('text-btn').addEventListener('click', async () => {
  const text = toText(closetTitle(), state.items);
  try {
    if (navigator.share) await navigator.share({ text });
    else {
      await navigator.clipboard.writeText(text);
      toast('List copied. Paste it into a message.');
    }
  } catch (err) {
    if (err.name !== 'AbortError') toast('Couldn\'t share the list.');
  }
});

$('csv-btn').addEventListener('click', async () => {
  const blob = new Blob([toCsv(sorted(state.items))], { type: 'text/csv' });
  await deliverFile(blob, `${fileSafe(closetTitle())} ${localDate()}.csv`, closetTitle());
});

$('backup-btn').addEventListener('click', async () => {
  toast('Preparing backup…');
  const blob = await buildBackup(state.settings);
  if (await deliverFile(blob, `${fileSafe(closetTitle())} backup ${localDate()}.closet.json`, 'Closet backup')) {
    await db.set('meta', 'lastBackup', new Date().toISOString());
    renderSettings();
  }
});

$('restore-btn').addEventListener('click', () => pick($('import-input')));

$('import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  let data;
  try {
    data = await readBackup(file);
  } catch (err) {
    return toast(err instanceof NotABackup ? err.message : 'That file couldn\'t be read.', 6000);
  }
  const n = data.items.length;
  const have = state.items.length;
  const when = new Date(data.exportedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const action = await choose(`Backup of ${data.name || (data.owner ? `${data.owner}'s Closet` : 'a closet')}`,
    `Made ${when}, ${plural(n, 'item')}.${have ? ` Restoring replaces the ${plural(have, 'item')} on this phone.` : ''}`, [
      { label: 'Restore: replace this phone\'s closet', value: 'replace', style: 'danger' },
      { label: 'Only add missing or newer items', value: 'merge' },
      { label: 'Cancel', value: null },
    ]);
  if (!action) return;
  toast('Restoring…', 10_000);
  if (action === 'merge') {
    const { added, updated } = await mergeIntoMine(data);
    toast(`${added} added, ${updated} updated.`);
  } else {
    await replaceMine(data);
    state.settings = { ...state.settings, ...data.settings, closetId: data.closetId || state.settings.closetId };
    await saveSettings();
    toast(`Restored ${plural(n, 'item')}.`);
  }
  for (const url of state.thumbUrls.values()) if (url) URL.revokeObjectURL(url);
  state.thumbUrls.clear();
  await loadData();
  for (const dlg of document.querySelectorAll('dialog[open]')) dlg.close();
  render();
});

// ---------- settings ----------

async function renderSettings() {
  const s = state.settings;
  $('s-owner').value = s.owner;
  $('s-name').value = s.closetName;
  $('s-name').placeholder = s.owner ? `${s.owner}'s Closet` : 'e.g. JG\'s Closet';
  $('s-auto-describe').checked = s.autoDescribe;
  $('s-api-key').value = state.apiKey;
  for (const [id, current] of [['s-photo-model', s.photoModel], ['s-style-model', s.styleModel]]) {
    $(id).innerHTML = Object.entries(MODELS).map(([m, label]) => `<option value="${m}"${m === current ? ' selected' : ''}>${esc(label)}</option>`).join('');
  }
  $('s-occasions').value = s.occasions.join('\n');
  $('s-categories').value = s.categories.join('\n');
  $('s-locations').value = s.locations.join('\n');
  const worn = state.looks.filter((l) => l.worn).length;
  $('tally').textContent = state.items.length
    ? `${plural(state.items.length, 'item')}, ${plural(state.items.reduce((n, i) => n + (i.photos?.length || 0), 0), 'photo')}, ${plural(worn, 'outfit')} logged as worn.` : '';

  const last = await db.get('meta', 'lastBackup');
  $('backup-status').textContent = (last
    ? `Last backup: ${new Date(last).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}.`
    : 'No backup yet.')
    + ' Deleting the app from the Home Screen deletes its data, so save a backup to Files / iCloud Drive now and then. Restoring replaces everything on this phone.';

  const pageVersion = document.querySelector('meta[name="app-version"]')?.content;
  $('version-status').textContent = `Installed version: ${versionNumber()}.`
    + (pageVersion === APP_VERSION ? '' : ' Some files are from another version: open the app again while online, or tap Check for updates.');
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  $('storage-status').textContent = [
    est?.usage != null ? `Using about ${Math.max(1, Math.round(est.usage / 1048576))} MB.` : '',
    persisted ? 'Storage is marked persistent.' : 'On iPhone, open the app from its Home Screen icon so its storage is kept.',
  ].filter(Boolean).join(' ');
}

const lines = (text) => [...new Set(text.split('\n').map((l) => l.trim()).filter(Boolean))];

$('settings').addEventListener('change', async (e) => {
  const s = state.settings;
  const v = e.target.value;
  switch (e.target.id) {
    case 's-owner': s.owner = v.trim(); $('s-name').placeholder = s.owner ? `${s.owner}'s Closet` : ''; break;
    case 's-name': s.closetName = v.trim(); break;
    case 's-auto-describe': s.autoDescribe = e.target.checked; break;
    case 's-photo-model': s.photoModel = v; break;
    case 's-style-model': s.styleModel = v; break;
    case 's-occasions': s.occasions = lines(v).length ? lines(v) : DEFAULT_OCCASIONS; break;
    case 's-categories': s.categories = lines(v).length ? lines(v) : DEFAULT_CATEGORIES; break;
    case 's-locations': s.locations = lines(v).length ? lines(v) : DEFAULT_LOCATIONS; break;
    case 's-api-key':
      state.apiKey = v.trim();
      await db.set('meta', 'apiKey', state.apiKey);
      if (state.apiKey && !state.apiKey.startsWith('sk-ant-')) toast('That doesn\'t look like a Claude API key (they start with sk-ant-).', 5000);
      return;
    default: return;
  }
  await saveSettings();
  render();
});

$('settings-btn').addEventListener('click', async () => {
  await renderSettings();
  openSheet($('settings'));
});

// ---------- version & updates ----------
// iOS freezes a Home Screen app as soon as it's closed, so an update only downloads while
// the app is open. The status next to the version says when it's safe to close.

function setUpdateStatus(text, working = false) {
  for (const el of document.querySelectorAll('.update-status')) {
    el.textContent = text ? `· ${text}` : '';
    el.classList.toggle('working', working);
  }
}

function watchInstall(worker, firstInstall) {
  const show = () => {
    if (worker.state === 'installing') {
      setUpdateStatus(firstInstall ? 'Saving for offline use, keep the app open…' : 'Downloading update, keep the app open…', true);
    } else if (worker.state === 'redundant') {
      setUpdateStatus('Update didn\'t finish, it will try again next time');
    } else if (worker.state === 'activated') {
      setUpdateStatus(firstInstall ? 'Ready to use offline' : 'Update installed, restarting…');
    }
  };
  worker.addEventListener('statechange', show);
  show();
}

async function startUpdates() {
  for (const el of document.querySelectorAll('.app-version')) el.textContent = `· v${versionNumber()}`;
  if (!('serviceWorker' in navigator)) return;

  // When a new version takes over, switch to it straight away unless something is open,
  // in which case say so instead of losing what you typed.
  const hadVersion = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadVersion) return; // first install, not an update
    if (!document.querySelector('dialog[open]')) location.reload();
    else toast('A new version is ready. Close and reopen the app to use it.', 8000);
  });

  // Listen on the existing registration before asking for a check, so a download that
  // starts (or fails) in the meantime can't slip past and be reported as "Up to date".
  let reg = await navigator.serviceWorker.getRegistration().catch(() => null);
  const firstInstall = !reg?.active;
  if (!reg) {
    try {
      reg = await navigator.serviceWorker.register('sw.js');
    } catch {
      return;
    }
  }
  reg.addEventListener('updatefound', () => watchInstall(reg.installing, firstInstall));
  if (reg.installing) return watchInstall(reg.installing, firstInstall);

  setUpdateStatus('Checking for updates…', true);
  try {
    await reg.update();
  } catch {
    return setUpdateStatus('Offline');
  }
  if (!reg.installing && !reg.waiting) setUpdateStatus('Up to date');
}

$('update-btn').addEventListener('click', async () => {
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => null);
  if (!reg) return toast('Updates need the app to be opened from its web address first.');
  const btn = $('update-btn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    await reg.update();
    toast(reg.installing || reg.waiting
      ? 'Downloading the update. Close the app and open it again in a moment.'
      : 'You have the latest version.', 6000);
  } catch {
    toast('Couldn\'t check for updates. Are you online?');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check for updates';
  }
});

// ---------- start-up ----------

async function start() {
  startUpdates();
  try { state.sort = localStorage.getItem('sort') || 'category'; } catch { /* private mode */ }
  $('sort').value = state.sort;
  await loadSettings();
  await loadData();
  render();
}

start();
