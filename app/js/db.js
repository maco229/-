// IndexedDB wrapper
const DB_NAME = 'shindanshi-anki';
const DB_VERSION = 1;
let dbPromise;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      const f = db.createObjectStore('folders', { keyPath: 'id' });
      f.createIndex('parentId', 'parentId');
      const c = db.createObjectStore('cards', { keyPath: 'id' });
      c.createIndex('unitId', 'unitId');
      c.createIndex('subjectId', 'subjectId');
      db.createObjectStore('images', { keyPath: 'id' });
      db.createObjectStore('kv');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export async function getAll(store, index, key) {
  const db = await openDB();
  const s = db.transaction(store).objectStore(store);
  return reqP(index ? s.index(index).getAll(key) : s.getAll());
}

export async function get(store, id) {
  if (id == null) return undefined;
  const db = await openDB();
  return reqP(db.transaction(store).objectStore(store).get(id));
}

export async function put(store, obj) {
  const db = await openDB();
  const t = db.transaction(store, 'readwrite');
  t.objectStore(store).put(obj);
  return txDone(t);
}

export async function putMany(store, list) {
  const db = await openDB();
  const t = db.transaction(store, 'readwrite');
  const s = t.objectStore(store);
  for (const o of list) s.put(o);
  return txDone(t);
}

export async function del(store, id) {
  const db = await openDB();
  const t = db.transaction(store, 'readwrite');
  t.objectStore(store).delete(id);
  return txDone(t);
}

export async function kvGet(key, fallback) {
  const db = await openDB();
  const v = await reqP(db.transaction('kv').objectStore('kv').get(key));
  return v === undefined ? fallback : v;
}

export async function kvSet(key, value) {
  const db = await openDB();
  const t = db.transaction('kv', 'readwrite');
  t.objectStore('kv').put(value, key);
  return txDone(t);
}

// Delete cards (and their images)
export async function deleteCards(cards) {
  const db = await openDB();
  const t = db.transaction(['cards', 'images'], 'readwrite');
  for (const c of cards) {
    t.objectStore('cards').delete(c.id);
    if (c.qImg) t.objectStore('images').delete(c.qImg);
    if (c.aImg) t.objectStore('images').delete(c.aImg);
  }
  return txDone(t);
}

// Delete a folder and everything below it
export async function deleteFolder(folder) {
  const db = await openDB();
  const folders = folder.kind === 'subject'
    ? [folder, ...(await getAll('folders', 'parentId', folder.id))]
    : [folder];
  const cards = folder.kind === 'subject'
    ? await getAll('cards', 'subjectId', folder.id)
    : await getAll('cards', 'unitId', folder.id);
  const t = db.transaction(['folders', 'cards', 'images'], 'readwrite');
  for (const f of folders) t.objectStore('folders').delete(f.id);
  for (const c of cards) {
    t.objectStore('cards').delete(c.id);
    if (c.qImg) t.objectStore('images').delete(c.qImg);
    if (c.aImg) t.objectStore('images').delete(c.aImg);
  }
  return txDone(t);
}

export async function clearAll() {
  const db = await openDB();
  const t = db.transaction(['folders', 'cards', 'images', 'kv'], 'readwrite');
  for (const s of ['folders', 'cards', 'images', 'kv']) t.objectStore(s).clear();
  return txDone(t);
}
