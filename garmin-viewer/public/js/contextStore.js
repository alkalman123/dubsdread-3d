// Same redeploy-survival trick as public/js/importStore.js, applied to the
// Coach's remembered notes (trips/objectives/equipment/schedule facts) —
// caches the current list in this browser's IndexedDB and silently
// restores it if the server ever comes back with none on record.

const DB_NAME = 'alpine-log-context';
const STORE = 'notes';
const KEY = 'latest';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  if (!('indexedDB' in window)) return null;
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const request = fn(store);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return null;
  }
}

export const contextStore = {
  save(notes) {
    return withStore('readwrite', (store) => store.put(notes, KEY));
  },
  async get() {
    return withStore('readonly', (store) => store.get(KEY));
  },
};
