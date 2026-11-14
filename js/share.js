// Backup files, and the spreadsheet / message exports.
//
// A backup file is JSON:
//   { format: 'closet-inventory', version: 1, closetId, name, owner, exportedAt,
//     items: [...], photos: { photoId: base64 }, thumbs: { photoId: base64 }, looks: [...], settings }
// The Claude API key is never included.

import * as db from './db.js';
import { blobToBase64, base64ToBlob } from './images.js';

const FORMAT = 'closet-inventory';

export async function buildBackup(settings) {
  const items = await db.getAll('items');
  const photos = {};
  const thumbs = {};
  for (const item of items) {
    for (const p of item.photos || []) {
      const full = await db.get('photos', p);
      const small = await db.get('thumbs', p);
      if (full) photos[p] = await blobToBase64(full);
      if (small) thumbs[p] = await blobToBase64(small);
    }
  }
  const file = {
    format: FORMAT,
    version: 1,
    closetId: settings.closetId,
    name: settings.closetName,
    owner: settings.owner,
    exportedAt: new Date().toISOString(),
    items,
    photos,
    thumbs,
    looks: await db.getAll('looks'),
    settings: { ...settings },
  };
  return new Blob([JSON.stringify(file)], { type: 'application/json' });
}

export class NotABackup extends Error {}

export async function readBackup(blob) {
  let data;
  try {
    data = JSON.parse(await blob.text());
  } catch {
    throw new NotABackup('That file isn\'t a closet backup.');
  }
  if (data?.format !== FORMAT || !Array.isArray(data.items)) throw new NotABackup('That file isn\'t a closet backup.');
  if (data.version > 1) throw new NotABackup('That backup was made by a newer version of the app. Update this app first (Settings → Check for updates).');
  return data;
}

function photoOps(data, item) {
  return (item.photos || []).flatMap((p) => [
    ...(data.photos?.[p] ? [{ store: 'photos', key: p, value: base64ToBlob(data.photos[p]) }] : []),
    ...(data.thumbs?.[p] ? [{ store: 'thumbs', key: p, value: base64ToBlob(data.thumbs[p]) }] : []),
  ]);
}

/** Adds items and looks that are missing here or newer in the file. */
export async function mergeIntoMine(data) {
  const mine = new Map((await db.getAll('items')).map((i) => [i.id, i]));
  const ops = [];
  let added = 0;
  let updated = 0;
  for (const item of data.items) {
    const have = mine.get(item.id);
    if (have && (have.updated || '') >= (item.updated || '')) continue;
    have ? updated++ : added++;
    if (have) ops.push(...db.deleteItemOps(have).filter((o) => o.store !== 'items'));
    ops.push({ store: 'items', value: item }, ...photoOps(data, item));
  }
  const looks = new Set(await db.getAllKeys('looks'));
  for (const look of data.looks || []) if (!looks.has(look.id)) ops.push({ store: 'looks', value: look });
  await db.putMany(ops);
  return { added, updated };
}

/** Replaces everything on this phone with the backup (moving to a new phone). */
export async function replaceMine(data) {
  const ops = [];
  for (const store of ['items', 'photos', 'thumbs', 'looks']) {
    for (const key of await db.getAllKeys(store)) ops.push({ store, key });
  }
  for (const item of data.items) ops.push({ store: 'items', value: item }, ...photoOps(data, item));
  for (const look of data.looks || []) ops.push({ store: 'looks', value: look });
  await db.putMany(ops);
}

// ---------- spreadsheet and message exports ----------

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(items) {
  const cols = [
    ['Name', 'name'], ['Category', 'category'], ['Type', 'subtype'], ['Colours', 'colours'], ['Pattern', 'pattern'],
    ['Material', 'material'], ['Brand', 'brand'], ['Size', 'size'], ['Season', 'season'], ['Dress code (1-5)', 'formality'],
    ['Location', 'location'], ['Status', 'status'], ['Times worn', 'wornCount'], ['Last worn', 'lastWorn'],
    ['Photos', (i) => (i.photos || []).length], ['Style notes', 'description'], ['Notes', 'notes'],
    ['Added', (i) => (i.added ? new Date(i.added).toLocaleDateString('en-CA') : '')],
  ];
  const rows = [cols.map(([h]) => h)];
  for (const i of items) rows.push(cols.map(([, f]) => (typeof f === 'function' ? f(i) : i[f])));
  // A byte-order mark so Excel reads £, é etc. correctly.
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function toText(title, items) {
  const byLoc = new Map();
  for (const i of items) {
    const k = i.location || 'No location';
    if (!byLoc.has(k)) byLoc.set(k, []);
    byLoc.get(k).push(i);
  }
  const lines = [title, ''];
  for (const [loc, list] of [...byLoc].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${loc}:`);
    for (const i of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const bits = [i.category, i.colours, i.status !== 'In closet' && i.status].filter(Boolean);
      lines.push(`• ${i.name}${bits.length ? ` (${bits.join(', ')})` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}
