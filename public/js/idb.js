// Minimal IndexedDB wrapper for audio that must survive until it is transcribed.
// Stores: chunks (pending normal chunks), meetings (meeting state), audio (meeting audio pieces).

const DB_NAME = "whisperflow";
const VERSION = 1;

let dbPromise = null;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("chunks")) db.createObjectStore("chunks", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meetings")) db.createObjectStore("meetings", { keyPath: "id" });
      if (!db.objectStoreNames.contains("audio")) {
        const audio = db.createObjectStore("audio", { keyPath: ["meetingId", "file", "n"] });
        audio.createIndex("meeting", "meetingId");
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function done(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(storeName, mode, fn) {
  const db = await open();
  const tx = db.transaction(storeName, mode);
  const result = fn(tx.objectStore(storeName));
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  });
  return result instanceof IDBRequest ? result.result : result;
}

export const put = (store, value) => run(store, "readwrite", (s) => s.put(value));
export const remove = (store, key) => run(store, "readwrite", (s) => s.delete(key));
export const getOne = (store, key) => run(store, "readonly", (s) => s.get(key));
export const getAll = (store) => run(store, "readonly", (s) => s.getAll());

// Audio pieces of one meeting, ordered by file then n.
export async function meetingAudio(meetingId) {
  const db = await open();
  const index = db.transaction("audio", "readonly").objectStore("audio").index("meeting");
  const rows = await done(index.getAll(meetingId));
  return rows.sort((a, b) => a.file - b.file || a.n - b.n);
}

export async function removeMeetingAudio(meetingId) {
  const db = await open();
  const tx = db.transaction("audio", "readwrite");
  const store = tx.objectStore("audio");
  const keys = await done(store.index("meeting").getAllKeys(meetingId));
  for (const key of keys) store.delete(key);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
