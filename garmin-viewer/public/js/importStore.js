// Keeps a copy of the last-imported health-data file in the browser's own
// IndexedDB, and re-uploads it automatically if the server ever comes back
// with no import on record.
//
// Why this exists: the server stores the import as a plain file
// (server/.data/healthImport.json). Render's free tier wipes that disk on
// every deploy, so without this, every code push would silently erase years
// of imported history and body-composition data until you noticed and
// re-uploaded it by hand. The browser's copy survives deploys because it
// never lived on the server's disk in the first place.

const DB_NAME = 'alpine-log';
const STORE = 'importBlob';
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
      // Always resolve with the request's own .result, even when that's
      // legitimately undefined (e.g. get() on a key that was never saved —
      // "nothing cached yet" is a real, valid answer, not a reason to fall
      // back to returning the pending IDBRequest object itself).
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Private browsing / disabled storage / etc. — degrade to "no cache",
    // the app still works, it just won't survive a redeploy without a
    // manual re-import.
    return null;
  }
}

export const importStore = {
  save(text) {
    return withStore('readwrite', (store) => store.put(text, KEY));
  },
  async get() {
    return withStore('readonly', (store) => store.get(KEY));
  },
  clear() {
    return withStore('readwrite', (store) => store.delete(KEY));
  },
};
