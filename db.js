// db.js — IndexedDB wrapper. Every record id is globally unique (device_id + uuid)
// so exports from two devices can be merged with a plain put(), no collision logic needed.

const DB_NAME = 'survey-logger';
const DB_VERSION = 1;
const STORES = ['meta', 'tags', 'events', 'track_points', 'focals', 'focal_intervals', 'blows'];

let _db = null;

function uuid() {
  return crypto.randomUUID();
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(storeName, mode = 'readonly') {
  return _db.transaction(storeName, mode).objectStore(storeName);
}

function put(storeName, record) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readwrite').put(record);
    req.onsuccess = () => resolve(record);
    req.onerror = () => reject(req.error);
  });
}

function getAll(storeName) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function clearStore(storeName) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readwrite').clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function count(storeName) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function get(storeName, id) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// meta is a single-row key/value store: { id: 'config', device_id, device_label }
async function getConfig() {
  const cfg = await get('meta', 'config');
  return cfg || null;
}

async function setConfig(patch) {
  const existing = (await getConfig()) || { id: 'config' };
  const merged = { ...existing, ...patch, id: 'config' };
  await put('meta', merged);
  return merged;
}

const DEFAULT_TAGS = ['CTD', 'eDNA', 'Trawl', 'Calibration', 'Anchor', 'Wildlife'];

async function ensureDefaultTags() {
  const existing = await getAll('tags');
  if (existing.length > 0) return;
  for (const label of DEFAULT_TAGS) {
    await put('tags', { id: uuid(), label, active: true });
  }
}

const DB = {
  uuid,
  openDB,
  put,
  getAll,
  get,
  clearStore,
  count,
  getConfig,
  setConfig,
  ensureDefaultTags,
};
