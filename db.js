// db.js — IndexedDB wrapper. Every record id is globally unique (device_id + uuid)
// so exports from two devices can be merged with a plain put(), no collision logic needed.

const DB_NAME = 'survey-logger';
// v2: the single blow button became a set of timestamped behaviours, so the
// 'blows' store was superseded by 'behaviors'. The old store is migrated but NOT
// deleted - a half-completed copy that then dropped the source would lose field
// data, and an empty object store costs nothing.
// v3: added 'transects' for on/off-effort tracking.
// v4: added 'trawls' for trawl on/off-effort tracking (scope/speed/RPM).
const DB_VERSION = 4;
const STORES = ['meta', 'tags', 'events', 'track_points', 'focals', 'focal_intervals', 'behaviors', 'transects', 'trawls'];
const LEGACY_BLOWS = 'blows';

let _db = null;

function uuid() {
  return crypto.randomUUID();
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      }
      // Every row in the old store was a blow by definition, so it carries
      // across as behavior: 'blow'. Runs inside the version-change transaction,
      // so either the whole migration lands or the upgrade fails and the old
      // database is untouched.
      if (ev.oldVersion < 2 && db.objectStoreNames.contains(LEGACY_BLOWS)) {
        const dst = req.transaction.objectStore('behaviors');
        req.transaction.objectStore(LEGACY_BLOWS).openCursor().onsuccess = (e) => {
          const cur = e.target.result;
          if (!cur) return;
          dst.put({ ...cur.value, behavior: 'blow' });
          cur.continue();
        };
      }
      // The other half of the same rename: the sticky transit/foraging state on
      // focals and intervals was called `behavior` before v2 and is now
      // `activity`. Without this, existing follows keep a field nothing reads
      // and export a blank activity column - a silent loss, not an error.
      if (ev.oldVersion < 2) {
        for (const name of ['focals', 'focal_intervals']) {
          if (!db.objectStoreNames.contains(name)) continue;
          const store = req.transaction.objectStore(name);
          store.openCursor().onsuccess = (e) => {
            const cur = e.target.result;
            if (!cur) return;
            const row = cur.value;
            if (row.activity === undefined && row.behavior !== undefined) {
              store.put({ ...row, activity: row.behavior });
            }
            cur.continue();
          };
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
