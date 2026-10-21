// Notes and folders persistence in localStorage.
// Note = { id, text, createdAt, updatedAt, folderId? }
// Folder = { id, name, createdAt }

const KEY = "whisperflow.notes.v2";
const V1_KEY = "whisperflow.notes.v1";
const DRAFT_KEY = "whisperflow.draft.v1";
const FOLDERS_KEY = "whisperflow.folders.v1";

function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function readAll() {
  const notes = readJson(KEY);
  if (!Array.isArray(notes)) return [];
  return notes.filter((n) => n && typeof n.id === "string" && typeof n.text === "string");
}

// Writes may throw (e.g. quota); the UI catches that.
function writeAll(notes) {
  localStorage.setItem(KEY, JSON.stringify(notes));
}

export function migrate() {
  const now = new Date().toISOString();

  if (localStorage.getItem(KEY) === null) {
    const old = readJson(V1_KEY);
    if (Array.isArray(old)) {
      const notes = old
        .filter((n) => typeof n?.text === "string" && n.text.trim())
        .map((n) => {
          const time = typeof n.time === "string" ? n.time : now;
          return {
            id: typeof n.id === "string" ? n.id : newId(),
            text: n.text,
            createdAt: time,
            updatedAt: time,
          };
        });
      writeAll(notes);
    }
  }

  if (localStorage.getItem(DRAFT_KEY) !== null) {
    const draft = readJson(DRAFT_KEY);
    const text = typeof draft?.text === "string" ? draft.text : "";
    const trimmed = text.trim();
    if (trimmed && !readAll().some((n) => n.text.trim() === trimmed)) {
      const time = typeof draft.time === "string" ? draft.time : now;
      writeAll([...readAll(), { id: newId(), text, createdAt: time, updatedAt: time }]);
    }
    localStorage.removeItem(DRAFT_KEY);
  }
}

export function listNotes() {
  return readAll().sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
}

export function getNote(id) {
  return readAll().find((n) => n.id === id) ?? null;
}

export function createNote(text = "", folderId = null) {
  const now = new Date().toISOString();
  const note = { id: newId(), text, createdAt: now, updatedAt: now, folderId };
  writeAll([...readAll(), note]);
  return note;
}

export function updateNote(id, text) {
  const notes = readAll();
  const index = notes.findIndex((n) => n.id === id);
  if (index < 0) return null;
  if (notes[index].text === text) return notes[index];

  notes[index] = { ...notes[index], text, updatedAt: new Date().toISOString() };
  writeAll(notes);
  return notes[index];
}

export function deleteNote(id) {
  const notes = readAll();
  const index = notes.findIndex((n) => n.id === id);
  if (index < 0) return null;

  const [removed] = notes.splice(index, 1);
  writeAll(notes);
  return removed;
}

export function restoreNote(note) {
  const notes = readAll().filter((n) => n.id !== note.id);
  const restored = { ...note };
  // Its folder may have been deleted since.
  if (!listFolders().some((f) => f.id === restored.folderId)) restored.folderId = null;
  writeAll([...notes, restored]);
  return restored;
}

// Moving a note keeps updatedAt, so the list order does not change.
export function setNoteFolder(id, folderId) {
  const notes = readAll();
  const index = notes.findIndex((n) => n.id === id);
  if (index < 0) return null;

  notes[index] = { ...notes[index], folderId };
  writeAll(notes);
  return notes[index];
}

// ---------- Folders ----------

export function listFolders() {
  const folders = readJson(FOLDERS_KEY);
  if (!Array.isArray(folders)) return [];
  return folders.filter((f) => f && typeof f.id === "string" && typeof f.name === "string");
}

function writeFolders(folders) {
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
}

export function createFolder(name) {
  const folder = { id: newId(), name, createdAt: new Date().toISOString() };
  writeFolders([...listFolders(), folder]);
  return folder;
}

export function renameFolder(id, name) {
  writeFolders(listFolders().map((f) => (f.id === id ? { ...f, name } : f)));
}

// Notes in the folder are kept and lose their folder.
export function deleteFolder(id) {
  writeAll(readAll().map((n) => (n.folderId === id ? { ...n, folderId: null } : n)));
  writeFolders(listFolders().filter((f) => f.id !== id));
}
