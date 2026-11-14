// Thin promise wrapper around IndexedDB. Everything lives on this device only.
//
// Stores:
//   meta     key/value settings: 'settings', 'apiKey', 'lastBackup'
//   items    { id, name, category, ..., photos: [photoId, ...] }   up to 4 photos per item
//   photos   photoId -> Blob   full photo, about 1280 px
//   thumbs   photoId -> Blob   square copy for the grid
//   looks    { id, date, occasion, itemIds, title, why, tip, worn }   saved and worn outfits

const DB_NAME = 'closet';
let dbPromise;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('meta');
      d.createObjectStore('items', { keyPath: 'id' });
      d.createObjectStore('photos');
      d.createObjectStore('thumbs');
      d.createObjectStore('looks', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const committed = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted (device may be out of space)'));
});

export async function get(store, key) {
  return done((await db()).transaction(store).objectStore(store).get(key));
}

export async function getAll(store) {
  return done((await db()).transaction(store).objectStore(store).getAll());
}

export async function getAllKeys(store) {
  return done((await db()).transaction(store).objectStore(store).getAllKeys());
}

export async function set(store, key, value) {
  const tx = (await db()).transaction(store, 'readwrite');
  const s = tx.objectStore(store);
  s.keyPath ? s.put(value) : s.put(value, key);
  return committed(tx);
}

export async function del(store, key) {
  const tx = (await db()).transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return committed(tx);
}

/** Write many records in one transaction. ops: [{ store, key?, value }]; value undefined deletes. */
export async function putMany(ops) {
  if (!ops.length) return;
  const stores = [...new Set(ops.map((o) => o.store))];
  const tx = (await db()).transaction(stores, 'readwrite');
  for (const { store, key, value } of ops) {
    const s = tx.objectStore(store);
    if (value === undefined) s.delete(key);
    else s.keyPath ? s.put(value) : s.put(value, key);
  }
  return committed(tx);
}

/** Ops that delete an item and all its photos. */
export const deleteItemOps = (item) => [
  { store: 'items', key: item.id },
  ...(item.photos || []).flatMap((p) => [{ store: 'photos', key: p }, { store: 'thumbs', key: p }]),
];
