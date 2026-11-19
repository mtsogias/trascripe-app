// Whisperflow UI: note list, editor, recording sheet and dictation into the editor.
import * as store from "./store.js";
import * as backup from "./backup.js";
import * as diag from "./diag.js";
import * as settings from "./settings.js";
import * as pending from "./pending.js";
import * as meeting from "./meeting.js";
import * as api from "./api.js";
import { TranscriptionSession } from "./session.js";
import { createWaveform } from "./waveform.js";

const $ = (sel) => document.querySelector(sel);

const app = $("#app");
const listView = $("#listView");
const editorView = $("#editorView");
const searchInput = $("#searchInput");
const notesList = $("#notesList");
const listTitle = $("#listTitle");
const sidebar = $("#sidebar");
const sidebarBtn = $("#sidebarBtn");
const sidebarBackdrop = $("#sidebarBackdrop");
const folderList = $("#folderList");
const newFolderBtn = $("#newFolderBtn");
const backupStatus = $("#backupStatus");
const diagBtn = $("#diagBtn");
const backupBtn = $("#backupBtn");
const folderMenuBtn = $("#folderMenuBtn");
const folderMenu = $("#folderMenu");
const backLabel = $("#backLabel");
const emptyState = $("#emptyState");
const backBtn = $("#backBtn");
const copyBtn = $("#copyBtn");
const shareBtn = $("#shareBtn");
const deleteBtn = $("#deleteBtn");
const editorDate = $("#editorDate");
const noteFolder = $("#noteFolder");
const folderPillText = $("#folderPillText");
const editorText = $("#editorText");
const dictateBtn = $("#dictateBtn");
const dictateBar = $(".dictate-bar");
const dictateWaveform = createWaveform($("#dictateWave"));
const recordBtn = $("#recordBtn");
const recordDock = $("#recordDock");
const recordSheet = $("#recordSheet");
const recordTimer = $("#recordTimer");
const liveText = $("#liveText");
const recordStatus = $("#recordStatus");
const recordWaveform = createWaveform($("#recordWave"));
const stopBtn = $("#stopBtn");
const meetingBtn = $("#meetingBtn");
const recordMode = $("#recordMode");
const summaryBtn = $("#summaryBtn");
const noteBanner = $("#noteBanner");
const noteBannerText = $("#noteBannerText");
const noteBannerBtn = $("#noteBannerBtn");
const speakerBar = $("#speakerBar");
const settingsSheet = $("#settingsSheet");
const settingsDone = $("#settingsDone");
const fallbackToggle = $("#fallbackToggle");
const modelSearch = $("#modelSearch");
const modelList = $("#modelList");
const summaryModelName = $("#summaryModelName");
const toastEl = $("#toast");
const toastText = $("#toastText");
const toastAction = $("#toastAction");

const DAY_MS = 86400000;
const TIME_FMT = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });
const DAY_FMT = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short" });
const DAY_YEAR_FMT = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", year: "numeric" });
const FULL_DATE_FMT = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long", year: "numeric" });
const FOLDER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
const TRASH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>`;
const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const START_ERRORS = {
  "mic-denied": "Mikrofon-Zugriff verweigert",
  "no-mic": "Kein Mikrofon gefunden",
  unsupported: "Aufnahme wird nicht unterstützt",
};
const SUMMARY_SEP = "\n\n————\n\n";
const ACTIVE_FOLDER_KEY = "whisperflow.activeFolder.v1";
const EDGE_PX = 28;        // edge swipes start this close to the left edge
const ACTIONS_PX = 160;    // width of a card's swipe actions
const NEW_FOLDER = "__new";
const MEETINGS = "__meetings"; // sidebar view of all meeting notes, across folders
const PEOPLE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.6"/><path d="M16 14.2a5 5 0 0 1 6 4.8"/></svg>`;

let recSession = null;     // active recording session (normal note)
let recMeeting = null;     // active meeting recording
let recNoteId = null;      // note id of the current recording (the note is created with the first text)
let recFinishing = false;
let recWarned = new Set(); // error kinds already shown during this recording
let dict = null;           // active dictation: { session, before, after, prefix, suffix, stopping }
let currentId = null;      // note open in the editor
let leaving = false;       // editor is closing (waiting for dictation to stop)
let saveTimer = null;
let timerId = null;
let startedAt = 0;
let wakeLock = null;
let toastTimer = null;
let activeFolder = loadActiveFolder(); // folder id shown in the list; null = "Alle", MEETINGS = meetings view
const newNoteFolder = () => (activeFolder === MEETINGS ? null : activeFolder);

const busy = () => recSession !== null || recMeeting !== null || dict !== null;

// ---------- Helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(text, { actionLabel, onAction, duration = 2600 } = {}) {
  clearTimeout(toastTimer);
  toastText.textContent = text;
  toastAction.hidden = !actionLabel;
  toastAction.textContent = actionLabel ?? "";
  toastAction.onclick = () => {
    hideToast();
    onAction?.();
  };
  toastEl.classList.add("is-visible");
  toastTimer = setTimeout(hideToast, duration);
}

function hideToast() {
  clearTimeout(toastTimer);
  toastEl.classList.remove("is-visible");
}

async function copyText(text) {
  if (!text) {
    toast("Nichts zu kopieren");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast("Kopiert");
}

// Runs a store write; a failure becomes a toast instead of an exception.
function safe(fn) {
  try {
    return fn();
  } catch {
    toast("Speichern fehlgeschlagen");
    return null;
  }
}

function countWords(text) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function wordLabel(text) {
  const n = countWords(text);
  return n === 1 ? "1 Wort" : `${n} Wörter`;
}

function dayStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// Whole calendar days between today and the given time (<= 0 means today).
function daysSince(iso) {
  return Math.round((dayStart(new Date()) - dayStart(new Date(iso))) / DAY_MS);
}

function relTime(iso) {
  const date = new Date(iso);
  const minutes = (Date.now() - date.getTime()) / 60000;
  if (minutes < 1) return "Gerade eben";
  if (minutes < 60) return `vor ${Math.floor(minutes)} Min.`;
  const time = TIME_FMT.format(date);
  const days = daysSince(iso);
  if (days <= 0) return time;
  if (days === 1) return `Gestern, ${time}`;
  if (date.getFullYear() === new Date().getFullYear()) return `${DAY_FMT.format(date)}, ${time}`;
  return DAY_YEAR_FMT.format(date);
}

function groupLabel(iso) {
  const days = daysSince(iso);
  if (days <= 0) return "Heute";
  if (days === 1) return "Gestern";
  if (days <= 7) return "Letzte 7 Tage";
  return "Älter";
}

function fullDate(iso) {
  const date = new Date(iso);
  return `${FULL_DATE_FMT.format(date)} um ${TIME_FMT.format(date)}`;
}

function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function startErrorMessage(err) {
  return START_ERRORS[err?.code] ?? "Aufnahme konnte nicht starten";
}

async function holdWakeLock() {
  try {
    const lock = await navigator.wakeLock?.request("screen");
    wakeLock = lock ?? null;
    diag.log(lock ? "wakelock on" : "wakelock unsupported");
    lock?.addEventListener("release", () => {
      diag.log("wakelock released");
      // The system can drop the lock while we are still recording (e.g. low power mode): take it back.
      if (wakeLock === lock && busy() && document.visibilityState === "visible") {
        wakeLock = null;
        holdWakeLock();
      }
    });
  } catch (err) {
    diag.log("wakelock failed", { err: err?.message });
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function autosize() {
  editorText.style.height = "auto";
  editorText.style.height = `${editorText.scrollHeight}px`;
}

// Reports a one-finger horizontal drag on target; vertical drags are left to scrolling.
// start(touch) returns a state object to begin, or null to ignore the touch.
function onHorizontalDrag(target, { start, move, end }) {
  let drag = null;
  target.addEventListener("touchstart", (event) => {
    drag = null;
    if (event.touches.length !== 1) return;
    const t = event.touches[0];
    const state = start(t, event);
    if (state) drag = { state, x: t.clientX, y: t.clientY, dx: 0, time: event.timeStamp, active: false };
  }, { passive: true });

  target.addEventListener("touchmove", (event) => {
    if (!drag) return;
    const t = event.touches[0];
    const dx = t.clientX - drag.x;
    const dy = t.clientY - drag.y;
    if (!drag.active) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dx) <= Math.abs(dy)) {
        drag = null; // vertical: let it scroll
        return;
      }
      drag.active = true;
    }
    event.preventDefault();
    drag.dx = dx;
    move(drag.state, dx);
  }, { passive: false });

  const finish = (event) => {
    if (!drag) return;
    const { state, active, dx, time } = drag;
    drag = null;
    if (active) end(state, dx, dx / Math.max(1, event.timeStamp - time));
  };
  target.addEventListener("touchend", finish);
  target.addEventListener("touchcancel", finish);
}

// Fills a folder <select>; returns the note's folder (an unknown id counts as no folder).
function fillFolderSelect(select, folderId) {
  const folders = store.listFolders();
  const current = folders.find((f) => f.id === folderId) ?? null;
  const option = (label, value) => {
    const o = el("option", undefined, label);
    o.value = value;
    return o;
  };
  select.replaceChildren(
    option("Kein Ordner", ""),
    ...folders.map((f) => option(f.name, f.id)),
    option("Neuer Ordner …", NEW_FOLDER),
  );
  select.value = current ? current.id : "";
  return current;
}

// Moves a note after a folder <select> changed; "Neuer Ordner …" asks for a name first.
function moveNoteFromSelect(noteId, select) {
  let folderId = select.value || null;
  if (folderId === NEW_FOLDER) folderId = createFolderFlow()?.id;
  // undefined = cancelled "new folder"
  if (folderId !== undefined) safe(() => store.setNoteFolder(noteId, folderId));
}

function toastDeleted(deleted) {
  // Saved audio of the note goes once undo is no longer possible.
  setTimeout(() => {
    if (store.getNote(deleted.id)) return;
    pending.forget(deleted.id);
    meeting.forget(deleted.id);
  }, 6000);
  toast("Notiz gelöscht", {
    actionLabel: "Widerrufen",
    duration: 5000,
    onAction: () => {
      safe(() => store.restoreNote(deleted));
      renderList();
    },
  });
}

// ---------- List view ----------

function noteCard(note, folderName, showMeeting = true) {
  const card = el("article", "note-card");
  card.dataset.id = note.id;

  const open = el("button", "note-open");
  open.type = "button";
  const time = el("time", "note-time", relTime(note.updatedAt));
  time.dateTime = note.updatedAt;
  const meta = el("p", "note-meta");
  meta.append(time, el("span", "note-dot", "·"), el("span", "note-words", wordLabel(note.text)));
  if (note.meeting && showMeeting) {
    const badge = el("span", "note-meeting");
    badge.innerHTML = PEOPLE_ICON;
    badge.append("Meeting");
    meta.append(el("span", "note-dot", "·"), badge);
  }
  if (folderName) meta.append(el("span", "note-dot", "·"), el("span", "note-folder", folderName));
  open.append(el("p", "note-preview", note.text), meta);

  const copy = el("button", "note-copy icon-btn");
  copy.type = "button";
  copy.setAttribute("aria-label", "Kopieren");
  copy.innerHTML = COPY_ICON;

  card.append(open, copy);

  // Revealed by swiping the card to the left.
  const actions = el("div", "note-actions");
  const move = el("label", "note-action note-action-move");
  move.innerHTML = FOLDER_ICON;
  const select = el("select", "note-move");
  select.setAttribute("aria-label", "In Ordner verschieben");
  move.append(el("span", undefined, "Ordner"), select);
  const del = el("button", "note-action note-action-delete");
  del.type = "button";
  del.innerHTML = TRASH_ICON;
  del.append(el("span", undefined, "Löschen"));
  actions.append(move, del);

  const row = el("div", "note-swipe");
  row.dataset.id = note.id;
  row.append(actions, card);
  return row;
}

// ---------- Card swipe ----------

let openRow = null;     // card row whose actions are showing
let swipedAt = 0;       // a click right after a swipe is ignored

function setRowOpen(row, open) {
  const card = row.querySelector(".note-card");
  card.style.transition = "";
  card.style.transform = open ? `translateX(-${ACTIONS_PX}px)` : "";
  row.classList.toggle("is-open", open);
  if (open) {
    if (openRow && openRow !== row) setRowOpen(openRow, false);
    openRow = row;
    row.classList.add("is-swiping");
    fillFolderSelect(row.querySelector(".note-move"), store.getNote(row.dataset.id)?.folderId);
  } else {
    if (openRow === row) openRow = null;
    // Hide the actions once the card has slid back over them.
    setTimeout(() => {
      if (!row.classList.contains("is-open")) row.classList.remove("is-swiping");
    }, 300);
  }
}

onHorizontalDrag(notesList, {
  start(t, event) {
    const row = event.target.closest(".note-swipe");
    if (!row || event.target.closest(".note-actions") || t.clientX <= EDGE_PX) return null;
    if (openRow && openRow !== row) setRowOpen(openRow, false);
    return { row, card: row.querySelector(".note-card"), base: row.classList.contains("is-open") ? -ACTIONS_PX : 0 };
  },
  move({ row, card, base }, dx) {
    row.classList.add("is-swiping");
    card.style.transition = "none";
    const x = Math.min(0, Math.max(-ACTIONS_PX * 1.25, base + dx));
    card.style.transform = `translateX(${x}px)`;
  },
  end({ row, base }, dx, velocity) {
    swipedAt = Date.now();
    const x = base + dx;
    setRowOpen(row, velocity < -0.5 || (velocity <= 0.5 && x < -ACTIONS_PX / 2));
  },
});

function renderList() {
  const folders = store.listFolders();
  const folder = folders.find((f) => f.id === activeFolder) ?? null;
  if (!folder && activeFolder && activeFolder !== MEETINGS) setActiveFolder(null);
  const meetingsView = activeFolder === MEETINGS;
  const names = new Map(folders.map((f) => [f.id, f.name]));
  const all = store.listNotes();
  renderSidebar(folders, all);

  const title = folder ? folder.name : meetingsView ? "Meetings" : "Notizen";
  listTitle.textContent = title;
  backLabel.textContent = title;
  for (const item of folderMenu.querySelectorAll("[data-folder-only]")) item.hidden = !folder;

  const inFolder = folder ? all.filter((n) => n.folderId === folder.id) : meetingsView ? all.filter((n) => n.meeting) : all;
  const query = searchInput.value.trim().toLowerCase();
  const notes = query ? inFolder.filter((n) => n.text.toLowerCase().includes(query)) : inFolder;

  emptyState.hidden = all.length > 0;
  openRow = null;
  notesList.replaceChildren();
  if (all.length > 0 && notes.length === 0) {
    const empty = meetingsView ? "Noch keine Meetings" : "Noch keine Notizen in diesem Ordner";
    notesList.append(el("p", "empty-text", query ? "Keine Treffer" : empty));
    return;
  }

  // Notes arrive sorted by updatedAt, so each group is contiguous.
  let label = null;
  for (const note of notes) {
    const next = groupLabel(note.updatedAt);
    if (next !== label) {
      label = next;
      notesList.append(el("h2", "group-title", label));
    }
    notesList.append(noteCard(note, folder ? null : names.get(note.folderId), !meetingsView));
  }
}

notesList.addEventListener("click", (event) => {
  if (Date.now() - swipedAt < 400) return;
  const row = event.target.closest(".note-swipe");
  if (!row) return;

  if (event.target.closest(".note-action-delete")) {
    const deleted = safe(() => store.deleteNote(row.dataset.id));
    renderList();
    if (deleted) toastDeleted(deleted);
    return;
  }
  if (event.target.closest(".note-actions")) return; // the folder <select> handles itself
  // Tapping an open card only closes it.
  if (openRow) {
    setRowOpen(openRow, false);
    return;
  }

  const card = row.querySelector(".note-card");
  if (event.target.closest(".note-copy")) {
    const note = store.getNote(card.dataset.id);
    copyText(note ? note.text : "");
  } else if (event.target.closest(".note-open")) {
    openEditor(card.dataset.id);
  }
});

notesList.addEventListener("change", (event) => {
  const select = event.target.closest(".note-move");
  if (!select) return;
  moveNoteFromSelect(select.closest(".note-swipe").dataset.id, select);
  renderList();
});

searchInput.addEventListener("input", renderList);

// ---------- Folders ----------

function loadActiveFolder() {
  try {
    return localStorage.getItem(ACTIVE_FOLDER_KEY) || null;
  } catch {
    return null;
  }
}

function setActiveFolder(id) {
  activeFolder = id;
  try {
    if (id) localStorage.setItem(ACTIVE_FOLDER_KEY, id);
    else localStorage.removeItem(ACTIVE_FOLDER_KEY);
  } catch {}
}

function folderRow(name, id, count, icon = FOLDER_ICON) {
  const row = el("button", "folder-row");
  row.type = "button";
  row.dataset.id = id ?? "";
  const active = id === activeFolder;
  row.classList.toggle("is-active", active);
  row.setAttribute("aria-current", active ? "true" : "false");
  row.innerHTML = icon;
  row.append(el("span", "folder-row-name", name), el("span", "folder-row-count", String(count)));
  return row;
}

function renderSidebar(folders, notes) {
  const counts = new Map();
  for (const n of notes) counts.set(n.folderId, (counts.get(n.folderId) ?? 0) + 1);
  const meetings = notes.filter((n) => n.meeting).length;
  folderList.replaceChildren(
    folderRow("Alle Notizen", null, notes.length),
    ...(meetings || activeFolder === MEETINGS ? [folderRow("Meetings", MEETINGS, meetings, PEOPLE_ICON)] : []),
    ...folders.map((f) => folderRow(f.name, f.id, counts.get(f.id) ?? 0)),
  );
}

function openSidebar() {
  closeFolderMenu();
  renderBackup();
  app.classList.add("sidebar-open");
  sidebar.inert = false;
  sidebar.setAttribute("aria-hidden", "false");
  sidebarBtn.setAttribute("aria-expanded", "true");
  listView.inert = true;
  recordDock.inert = true;
}

function closeSidebar() {
  if (!app.classList.contains("sidebar-open")) return;
  app.classList.remove("sidebar-open");
  sidebar.inert = true;
  sidebar.setAttribute("aria-hidden", "true");
  sidebarBtn.setAttribute("aria-expanded", "false");
  listView.inert = false;
  recordDock.inert = false;
}

const sidebarOpen = () => app.classList.contains("sidebar-open");

// Follows the finger while the sidebar is dragged; x is its left edge (-width = closed, 0 = open).
function dragSidebar(x, width) {
  app.classList.add("sidebar-dragging");
  sidebar.style.transform = `translateX(${x}px)`;
  sidebarBackdrop.style.opacity = String(1 + x / width);
}

// Clearing the inline styles lets the CSS transition animate from the finger position.
function releaseSidebar() {
  app.classList.remove("sidebar-dragging");
  sidebar.style.transform = "";
  sidebarBackdrop.style.opacity = "";
}

// Swipe in from the left edge of the list to open the sidebar.
onHorizontalDrag(listView, {
  start(t) {
    if (t.clientX > EDGE_PX || sidebarOpen() || busy() || app.dataset.view !== "list") return null;
    return { width: sidebar.offsetWidth };
  },
  move({ width }, dx) {
    dragSidebar(Math.min(0, Math.max(-width, dx - width)), width);
  },
  end({ width }, dx, velocity) {
    releaseSidebar();
    if (velocity > 0.5 || (velocity >= -0.5 && dx > width * 0.35)) openSidebar();
  },
});

// Swipe the open sidebar (or the dimmed list) to the left to close it.
for (const target of [sidebar, sidebarBackdrop]) {
  onHorizontalDrag(target, {
    start() {
      return sidebarOpen() ? { width: sidebar.offsetWidth } : null;
    },
    move({ width }, dx) {
      dragSidebar(Math.min(0, Math.max(-width, dx)), width);
    },
    end({ width }, dx, velocity) {
      releaseSidebar();
      if (velocity < -0.5 || (velocity <= 0.5 && dx < -width * 0.35)) closeSidebar();
    },
  });
}

function showFolder(id) {
  setActiveFolder(id);
  closeSidebar();
  renderList();
  listView.scrollTop = 0;
}

// Asks for a folder name; null when cancelled, empty or already taken.
function askFolderName(message, current = "", exceptId = null) {
  const raw = prompt(message, current);
  if (raw === null) return null;
  const name = raw.trim().slice(0, 40);
  if (!name) return null;
  const lower = name.toLowerCase();
  if (store.listFolders().some((f) => f.id !== exceptId && f.name.toLowerCase() === lower)) {
    toast("Diesen Ordner gibt es schon");
    return null;
  }
  return name;
}

function createFolderFlow() {
  const name = askFolderName("Name des neuen Ordners");
  return name ? safe(() => store.createFolder(name)) : null;
}

sidebarBtn.addEventListener("click", openSidebar);
sidebarBackdrop.addEventListener("click", closeSidebar);

folderList.addEventListener("click", (event) => {
  const row = event.target.closest(".folder-row");
  if (row) showFolder(row.dataset.id || null);
});

newFolderBtn.addEventListener("click", () => {
  const folder = createFolderFlow();
  if (folder) showFolder(folder.id);
});

// ---------- Backup ----------

function noteCount(n) {
  return n === 1 ? "1 Notiz" : `${n} Notizen`;
}

function renderBackup() {
  const { setUp, lastAt, failed } = backup.status();
  let text = "Notizen sind nur auf diesem Gerät gespeichert";
  if (setUp && failed) text = "Backup fehlgeschlagen, neuer Versuch folgt";
  else if (setUp && lastAt) text = `Letztes Backup: ${relTime(lastAt)}`;
  else if (setUp) text = "Backup läuft …";
  backupStatus.textContent = text;
  backupStatus.classList.toggle("is-warning", !setUp || failed);
  backupBtn.textContent = setUp ? "Aus Backup wiederherstellen" : "Backup einrichten";
}

// Loads the server backup; null when there is none, undefined after an error (already shown).
async function loadBackup(password) {
  try {
    return await backup.fetchBackup(password);
  } catch (err) {
    toast(err.code === "auth" ? "Falsches Backup-Passwort" : "Backup-Server nicht erreichbar");
    return undefined;
  }
}

function applyBackup(data) {
  if (!safe(() => (store.replaceAll(data), true))) return;
  setActiveFolder(null);
  renderList();
  toast(`${noteCount(data.notes.length)} wiederhergestellt`);
}

async function setupBackup() {
  const raw = prompt("Backup-Passwort (BACKUP_PASSWORD aus Vercel)");
  const password = raw?.trim();
  if (!password) return;
  const existing = await loadBackup(password);
  if (existing === undefined) return;

  if (existing) {
    const found = `Backup vom ${fullDate(existing.savedAt)} mit ${noteCount(existing.notes.length)} gefunden.`;
    if (confirm(`${found} Wiederherstellen? Die Notizen auf diesem Gerät werden ersetzt.`)) {
      applyBackup(existing);
    } else if (!confirm("Dann wird das Backup durch die Notizen auf diesem Gerät ersetzt. Fortfahren?")) {
      return;
    }
  }
  backup.enable(password);
  renderBackup();
}

async function restoreBackup() {
  const data = await loadBackup();
  if (data === undefined) return;
  if (!data) {
    toast("Noch kein Backup vorhanden");
    return;
  }
  const found = `Backup vom ${fullDate(data.savedAt)} mit ${noteCount(data.notes.length)} laden?`;
  if (!confirm(`${found} Die Notizen auf diesem Gerät werden ersetzt.`)) return;
  closeSidebar();
  applyBackup(data);
}

diagBtn.addEventListener("click", () => copyText(diag.text()));

backupBtn.addEventListener("click", () => (backup.status().setUp ? restoreBackup() : setupBackup()));

backup.onStatus((event) => {
  renderBackup();
  if (event === "auth") toast("Backup-Passwort stimmt nicht mehr, bitte neu einrichten", { duration: 5000 });
});
store.onChange(() => backup.schedule());
window.addEventListener("online", () => backup.flush());

function closeFolderMenu() {
  folderMenu.hidden = true;
  folderMenuBtn.setAttribute("aria-expanded", "false");
}

folderMenuBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  const open = folderMenu.hidden;
  folderMenu.hidden = !open;
  folderMenuBtn.setAttribute("aria-expanded", String(open));
});

document.addEventListener("click", (event) => {
  if (!folderMenu.hidden && !folderMenu.contains(event.target)) closeFolderMenu();
});

folderMenu.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  closeFolderMenu();
  if (action === "settings") {
    openSettings();
    return;
  }
  const folder = store.listFolders().find((f) => f.id === activeFolder);
  if (!folder) return;

  if (action === "rename") {
    const name = askFolderName("Ordner umbenennen", folder.name, folder.id);
    if (name) safe(() => store.renameFolder(folder.id, name));
  } else if (action === "delete") {
    if (!confirm(`Ordner „${folder.name}“ löschen? Die Notizen darin bleiben unter „Alle“ erhalten.`)) return;
    safe(() => store.deleteFolder(folder.id));
    setActiveFolder(null);
  }
  renderList();
});

// ---------- Recording (new note) ----------

function openSheet(mode = "note") {
  liveText.textContent = "";
  liveText.dataset.placeholder = mode === "meeting"
    ? "Meeting läuft. Lass den Bildschirm an.\nDer Text mit Sprechern kommt nach dem Stoppen."
    : "Sprich einfach los …";
  recordMode.hidden = mode !== "meeting";
  recordStatus.textContent = "";
  recordTimer.textContent = "0:00";
  recordSheet.classList.remove("is-finishing");
  recordSheet.classList.add("is-open");
  recordSheet.setAttribute("aria-hidden", "false");
  recordSheet.inert = false;
}

function closeSheet() {
  recordSheet.classList.remove("is-open", "is-finishing");
  recordSheet.setAttribute("aria-hidden", "true");
  recordSheet.inert = true;
}

function startTimer() {
  startedAt = Date.now();
  recordTimer.textContent = "0:00";
  timerId = setInterval(() => {
    recordTimer.textContent = formatDuration(Date.now() - startedAt);
  }, 250);
}

function stopTimer() {
  clearInterval(timerId);
  timerId = null;
}

// A chunk could not be sent during a recording or dictation: say why, once per kind.
function warnChunk(err) {
  const kind = err?.allBlocked || api.isAccountProblem(err) ? `account-${err.code}` : "temporary";
  if (recWarned.has(kind)) return;
  recWarned.add(kind);
  if (kind === "temporary") {
    toast("Abschnitt gesichert, wird automatisch nachgereicht", { duration: 4000 });
  } else {
    toast(`${api.errorMessage(err)}. Die Aufnahme läuft weiter und wird gesichert.`, { duration: 7000 });
  }
}

async function startRecording() {
  if (busy()) return;
  openSheet();
  recWarned = new Set();
  recNoteId = store.newId();
  const session = new TranscriptionSession({
    noteId: recNoteId,
    onText: (full) => onRecordingText(session, full),
    onState: (state) => onRecordingState(session, state),
    onError: (err, kind) => onRecordingError(session, err, kind),
  });
  recSession = session;
  diag.begin("recording");
  try {
    await session.start();
  } catch (err) {
    diag.end(`start failed: ${err?.code || err?.message}`);
    // Stopped while starting: finishRecording owns the cleanup and toast.
    if (session !== recSession || recFinishing) return;
    recSession = null;
    recNoteId = null;
    closeSheet();
    toast(startErrorMessage(err));
    return;
  }
  recordWaveform.start(session.analyser);
  startTimer();
  holdWakeLock();
}

// Persist as we go so a crash mid-recording keeps the text.
function saveRecordingText(text) {
  if (store.getNote(recNoteId)) safe(() => store.updateNote(recNoteId, text));
  else safe(() => store.createNote(text, newNoteFolder(), recNoteId));
}

function onRecordingText(session, full) {
  if (session !== recSession) return;
  liveText.textContent = full;
  liveText.scrollTop = liveText.scrollHeight;
  saveRecordingText(full);
}

function onRecordingState(session, { phase, pending: count }) {
  if (session !== recSession || phase !== "finishing") return;
  recordStatus.textContent = count ? `Transkribiere … (${count})` : "Transkribiere …";
}

function onRecordingError(session, err, kind) {
  if (session !== recSession) return;
  if (kind === "fatal") finishRecording("mic error");
  else warnChunk(err);
}

async function finishRecording(reason = "stop button") {
  if (recMeeting) return finishMeeting(reason);
  const session = recSession;
  if (!session || recFinishing) return;
  recFinishing = true;
  diag.log("finishing", { reason });
  recordSheet.classList.add("is-finishing");
  stopTimer();
  recordWaveform.stop();
  recordStatus.textContent = "Transkribiere …";

  const text = await session.stop();
  const noteId = recNoteId;
  recSession = null;
  recNoteId = null;
  recFinishing = false;
  releaseWakeLock();
  closeSheet();
  diag.end(`${reason}, ${text.length} chars, ${session.failed} failed`);

  const exists = !!store.getNote(noteId);
  if (text) {
    if (exists) safe(() => store.updateNote(noteId, text));
    else safe(() => store.createNote(text, newNoteFolder(), noteId));
    renderList();
    openEditor(noteId);
  } else {
    if (exists) safe(() => store.deleteNote(noteId));
    renderList();
    toast("Nichts erkannt");
  }
}

// ---------- Meeting recording ----------

async function startMeeting() {
  if (busy()) return;
  openSheet("meeting");
  recWarned = new Set();
  recNoteId = store.newId();
  const rec = new meeting.MeetingRecording({
    noteId: recNoteId,
    onError: (err) => {
      if (rec !== recMeeting) return;
      if (err.code === "storage") {
        toast("Speicher voll: Die Aufnahme kann nicht mehr gesichert werden", { duration: 7000 });
      } else {
        finishMeeting("mic error");
      }
    },
  });
  recMeeting = rec;
  meeting.markActive(rec.id, true);
  diag.begin("meeting");
  try {
    await rec.start();
  } catch (err) {
    diag.end(`start failed: ${err?.code || err?.message}`);
    if (rec !== recMeeting || recFinishing) return;
    meeting.markActive(rec.id, false);
    recMeeting = null;
    recNoteId = null;
    closeSheet();
    toast(startErrorMessage(err));
    return;
  }
  recordWaveform.start(rec.analyser);
  startTimer();
  holdWakeLock();
}

function meetingPlaceholder(sec) {
  return `Meeting · ${Math.max(1, Math.round(sec / 60))} Min.\n\n${meeting.PLACEHOLDER}`;
}

async function finishMeeting(reason = "stop button") {
  const rec = recMeeting;
  if (!rec || recFinishing) return;
  recFinishing = true;
  diag.log("finishing", { reason });
  recordSheet.classList.add("is-finishing");
  stopTimer();
  recordWaveform.stop();
  recordStatus.textContent = "Speichere …";
  try {
    await rec.stop();
  } catch (err) {
    diag.log("meeting stop failed", { err: String(err) });
  }
  const noteId = recNoteId;
  meeting.markActive(rec.id, false);
  recMeeting = null;
  recNoteId = null;
  recFinishing = false;
  releaseWakeLock();
  closeSheet();
  diag.end(`${reason}, meeting ${Math.round(rec.durationSec)} s`);

  safe(() => store.createNote(meetingPlaceholder(rec.durationSec), newNoteFolder(), noteId, { meeting: true }));
  renderList();
  openEditor(noteId);
  meeting.retry({ noteId });
}

recordBtn.addEventListener("click", startRecording);
meetingBtn.addEventListener("click", startMeeting);
stopBtn.addEventListener("click", () => finishRecording());

// ---------- Editor ----------

function openEditor(id) {
  const note = store.getNote(id);
  if (!note) {
    renderList();
    return;
  }
  currentId = id;
  editorText.value = note.text;
  editorDate.textContent = fullDate(note.createdAt);
  renderNoteFolder(note.folderId);
  autosize();
  editorView.scrollTop = 0;
  app.dataset.view = "editor";
  listView.inert = true;
  editorView.classList.add("is-active");
  editorView.setAttribute("aria-hidden", "false");
  editorView.inert = false;
  renderSpeakers();
  refreshBanner();
}

function renderNoteFolder(folderId) {
  const current = fillFolderSelect(noteFolder, folderId);
  folderPillText.textContent = current ? current.name : "Kein Ordner";
}

noteFolder.addEventListener("change", () => {
  if (!currentId) return;
  moveNoteFromSelect(currentId, noteFolder);
  renderNoteFolder(store.getNote(currentId)?.folderId);
});

function hideEditor() {
  app.dataset.view = "list";
  editorView.classList.remove("is-active");
  editorView.setAttribute("aria-hidden", "true");
  editorView.inert = true;
  listView.inert = false;
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (currentId) safe(() => store.updateNote(currentId, editorText.value));
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

// Stops dictation and blurs the textarea; false if the editor is not open or already leaving.
async function beginLeave() {
  if (!currentId || leaving) return false;
  leaving = true;
  editorText.blur();
  await stopDictation();
  return true;
}

function endLeave() {
  currentId = null;
  leaving = false;
  hideEditor();
  renderList();
}

async function closeEditor() {
  if (!(await beginLeave())) return;
  saveNow();
  if (!editorText.value.trim()) safe(() => store.deleteNote(currentId));
  endLeave();
}

editorText.addEventListener("input", () => {
  autosize();
  scheduleSave();
});
window.addEventListener("resize", autosize);

backBtn.addEventListener("click", closeEditor);

// Swipe from the left edge to go back, like iOS navigation.
let swipe = null;

editorView.addEventListener("touchstart", (event) => {
  const t = event.touches[0];
  if (event.touches.length !== 1 || t.clientX > EDGE_PX || dict || leaving) return;
  swipe = { x: t.clientX, y: t.clientY, dx: 0, time: event.timeStamp, active: false };
}, { passive: true });

editorView.addEventListener("touchmove", (event) => {
  if (!swipe) return;
  const t = event.touches[0];
  const dx = t.clientX - swipe.x;
  const dy = t.clientY - swipe.y;
  if (!swipe.active) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    if (dx <= Math.abs(dy)) {
      swipe = null; // vertical scroll, not a swipe
      return;
    }
    swipe.active = true;
    editorView.style.transition = "none";
  }
  event.preventDefault();
  swipe.dx = Math.max(0, dx);
  editorView.style.transform = `translateX(${swipe.dx}px)`;
}, { passive: false });

function endSwipe(event) {
  if (!swipe) return;
  const { active, dx, time } = swipe;
  swipe = null;
  if (!active) return;
  // Clearing the inline styles lets the CSS transition animate from the finger position.
  editorView.style.transition = "";
  editorView.style.transform = "";
  const velocity = dx / Math.max(1, event.timeStamp - time);
  if (dx > editorView.clientWidth * 0.35 || velocity > 0.5) closeEditor();
}

editorView.addEventListener("touchend", endSwipe);
editorView.addEventListener("touchcancel", endSwipe);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (settingsSheet.classList.contains("is-open")) {
    closeSettings();
    return;
  }
  closeFolderMenu();
  closeSidebar();
  closeEditor();
});

copyBtn.addEventListener("click", () => copyText(editorText.value));

shareBtn.hidden = !navigator.share;
shareBtn.addEventListener("click", async () => {
  try {
    await navigator.share({ text: editorText.value });
  } catch (err) {
    if (err.name !== "AbortError") toast("Teilen nicht möglich");
  }
});

deleteBtn.addEventListener("click", async () => {
  if (!(await beginLeave())) return;
  saveNow();
  const deleted = safe(() => store.deleteNote(currentId));
  endLeave();
  if (deleted) toastDeleted(deleted);
});

// ---------- Dictation into the editor ----------

dictateBtn.addEventListener("click", () => (dict ? stopDictation() : startDictation()));

function resetDictationUi() {
  editorText.readOnly = false;
  dictateBtn.classList.remove("is-active", "is-busy");
  dictateBtn.setAttribute("aria-label", "Diktieren");
  dictateBar.classList.remove("is-active");
}

async function startDictation() {
  if (busy() || leaving || !currentId) return;
  const value = editorText.value;
  const before = value.slice(0, editorText.selectionStart);
  const after = value.slice(editorText.selectionEnd);
  const prefix = before && !/\s$/.test(before) ? " " : "";
  const suffix = after && !/^[\s.,!?;:]/.test(after) ? " " : "";

  const d = { before, after, prefix, suffix, session: null, stopping: null };
  recWarned = new Set();
  d.session = new TranscriptionSession({
    noteId: currentId,
    onText: (full) => {
      if (dict !== d) return;
      editorText.value = before + (full ? prefix + full + suffix : "") + after;
      autosize();
      saveNow(); // right away: the saved audio of this chunk is deleted next
    },
    onState: () => {},
    onError: (err, kind) => {
      if (dict !== d) return;
      if (kind === "fatal") stopDictation();
      else warnChunk(err);
    },
  });

  dict = d;
  diag.begin("dictation");
  editorText.readOnly = true;
  dictateBtn.classList.add("is-active");
  dictateBtn.setAttribute("aria-label", "Diktat beenden");
  dictateBar.classList.add("is-active");
  try {
    await d.session.start();
  } catch (err) {
    // Stopped while starting: finishDictation owns the cleanup and toast.
    diag.end(`start failed: ${err?.code || err?.message}`);
    if (dict !== d || d.stopping) return;
    dict = null;
    resetDictationUi();
    toast(startErrorMessage(err));
    return;
  }
  dictateWaveform.start(d.session.analyser);
  holdWakeLock();
}

// Idempotent: repeated calls share one promise.
function stopDictation() {
  if (!dict) return Promise.resolve();
  if (!dict.stopping) dict.stopping = finishDictation(dict);
  return dict.stopping;
}

async function finishDictation(d) {
  dictateBtn.classList.add("is-busy");
  dictateWaveform.stop();
  const full = await d.session.stop();
  dict = null;
  const ins = full ? d.prefix + full + d.suffix : "";
  const caret = d.before.length + ins.length;
  editorText.value = d.before + ins + d.after;
  resetDictationUi();
  autosize();
  saveNow();
  editorText.setSelectionRange(caret, caret);
  releaseWakeLock();
  diag.end(`dictation, ${full.length} chars, ${d.session.failed} failed`);
  refreshBanner();
  if (!full) toast("Nichts erkannt");
}

// ---------- Late text: retried chunks, meetings ----------

// Changes a note's text from outside the editor (late transcripts). fn(oldText | null) returns the new text,
// or undefined to leave it. Keeps the editor in sync when the note is open.
function withNoteText(noteId, fn) {
  const open = currentId === noteId && !leaving;
  if (open) saveNow();
  const note = store.getNote(noteId);
  const next = fn(note ? note.text : null);
  if (next === undefined || next === note?.text) return;
  if (note) safe(() => store.updateNote(noteId, next));
  else safe(() => store.createNote(next, null, noteId));
  if (open) {
    const caret = editorText.selectionStart;
    const delta = next.length - editorText.value.length;
    const atEnd = caret >= editorText.value.length;
    editorText.value = next;
    const pos = atEnd ? next.length : Math.max(0, Math.min(next.length, caret + (caret > 0 ? delta : 0)));
    if (document.activeElement === editorText) editorText.setSelectionRange(pos, pos);
    autosize();
    renderSpeakers();
  }
  if (app.dataset.view === "list") renderList();
}

// Puts a late chunk's text where its marker is. Returns true when the saved chunk can go.
function applyChunk(rec, text) {
  withNoteText(rec.noteId, (old) => {
    // A failed chunk whose note is gone: the note was deleted, so the text is not wanted.
    if (old === null) return rec.status === "failed" || !text ? undefined : text;
    if (old.includes(rec.marker)) {
      const replaced = old.replace(rec.marker, text);
      return text ? replaced : replaced.replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n");
    }
    // Marker edited away (or never placed after a crash): add the text at the end.
    return text ? `${old.trimEnd()}\n\n${text}` : undefined;
  });
  return true;
}

function applyMeeting(m, text, speakers) {
  withNoteText(m.noteId, (old) => {
    if (old === null) return text;
    const head = old.indexOf(`\n\n${meeting.PLACEHOLDER}`);
    if (head >= 0 && old.startsWith("Meeting · ")) {
      return text + old.slice(head + 2 + meeting.PLACEHOLDER.length);
    }
    if (old.includes(meeting.PLACEHOLDER)) return old.replace(meeting.PLACEHOLDER, text);
    return `${old.trimEnd()}\n\n${text}`;
  });
  safe(() => store.setNoteFields(m.noteId, speakers.length ? { meeting: true, speakers } : { meeting: true }));
  if (currentId === m.noteId) renderSpeakers();
  return true;
}

let bannerRun = 0;

async function refreshBanner() {
  const run = ++bannerRun;
  const noteId = currentId;
  if (!noteId) {
    noteBanner.hidden = true;
    return;
  }
  const [counts, meetings] = await Promise.all([pending.countByNote(), meeting.statusByNote()]);
  if (run !== bannerRun || noteId !== currentId) return;
  const m = meetings.get(noteId);
  const open = counts.get(noteId) ?? 0;
  let text = "";
  let busyNow = false;
  let canRetry = false;
  if (m && m.status !== "failed") {
    text = "Meeting wird transkribiert …";
    busyNow = true;
  } else if (m) {
    text = `Meeting noch nicht transkribiert${m.lastError ? `: ${m.lastError}` : ""}`;
    canRetry = true;
  } else if (open) {
    text = open === 1 ? "1 Stelle wird noch nachgereicht" : `${open} Stellen werden noch nachgereicht`;
    canRetry = true;
  }
  noteBanner.hidden = !text;
  noteBannerText.textContent = text;
  noteBanner.classList.toggle("is-busy", busyNow || noteBannerBtn.disabled);
  noteBannerBtn.hidden = !canRetry;
}

noteBannerBtn.addEventListener("click", async () => {
  const noteId = currentId;
  if (!noteId || noteBannerBtn.disabled) return;
  noteBannerBtn.disabled = true;
  noteBanner.classList.add("is-busy");
  try {
    const [chunks] = await Promise.all([
      pending.retry({ force: true, noteId }),
      meeting.retry({ force: true, noteId }),
    ]);
    if (chunks?.failed) toast("Noch nicht geklappt, die App versucht es weiter");
  } finally {
    noteBannerBtn.disabled = false;
    refreshBanner();
  }
});

// ---------- Speakers ----------

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function renderSpeakers() {
  const note = currentId ? store.getNote(currentId) : null;
  const speakers = Array.isArray(note?.speakers) ? note.speakers : [];
  speakerBar.replaceChildren();
  speakerBar.hidden = !speakers.length;
  if (!speakers.length) return;
  speakerBar.append(el("span", undefined, "Sprecher benennen:"));
  for (const name of speakers) {
    const chip = el("button", "speaker-chip", name);
    chip.type = "button";
    chip.dataset.name = name;
    speakerBar.append(chip);
  }
}

speakerBar.addEventListener("click", (event) => {
  const chip = event.target.closest(".speaker-chip");
  if (!chip || !currentId || dict) return;
  const old = chip.dataset.name;
  const raw = prompt(`Name für „${old}“`, old.startsWith("Sprecher ") ? "" : old);
  const name = raw?.replace(/[:\n\r[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!name || name === old) return;
  const note = store.getNote(currentId);
  const speakers = note?.speakers ?? [];
  if (speakers.includes(name)) {
    toast("Diesen Namen gibt es schon");
    return;
  }
  // Only speaker labels at the start of a turn ("[1:23] Name: …") are renamed.
  const label = new RegExp(`^(\\[[\\d:]+\\] )${escapeRe(old)}:`, "gm");
  withNoteText(currentId, (text) => (text === null ? undefined : text.replace(label, `$1${name}:`)));
  safe(() => store.setNoteFields(currentId, { speakers: speakers.map((s) => (s === old ? name : s)) }));
  renderSpeakers();
});

// ---------- Summary ----------

let summarizing = false;

summaryBtn.addEventListener("click", async () => {
  if (!currentId || dict || leaving || summarizing) return;
  saveNow();
  const noteId = currentId;
  const full = editorText.value;
  // A second run replaces the old summary instead of summarising it too.
  const sep = full.indexOf(SUMMARY_SEP);
  const body = (full.startsWith("Zusammenfassung") && sep >= 0 ? full.slice(sep + SUMMARY_SEP.length) : full).trim();
  if (!body) {
    toast("Nichts zum Zusammenfassen");
    return;
  }
  summarizing = true;
  summaryBtn.classList.add("is-busy");
  editorText.readOnly = true;
  toast("Fasse zusammen …", { duration: 60000 });
  try {
    const { summary } = await api.summarize(body, settings.get().summaryModel);
    withNoteText(noteId, (text) => {
      if (text === null) return undefined;
      const s2 = text.indexOf(SUMMARY_SEP);
      const rest = text.startsWith("Zusammenfassung") && s2 >= 0 ? text.slice(s2 + SUMMARY_SEP.length) : text;
      return `${summary.trim()}${SUMMARY_SEP}${rest.trimStart()}`;
    });
    hideToast();
    if (currentId === noteId) editorView.scrollTop = 0;
  } catch (err) {
    toast(`Zusammenfassung fehlgeschlagen: ${api.errorMessage({ ...err, provider: "openrouter" })}`, { duration: 6000 });
  } finally {
    summarizing = false;
    summaryBtn.classList.remove("is-busy");
    if (!dict) editorText.readOnly = false;
  }
});

// ---------- Settings ----------

let models = null; // [{ id, name, prompt, completion }] from OpenRouter, loaded on first open
let modelsFailed = false;

function openSettings() {
  const current = settings.get();
  for (const radio of settingsSheet.querySelectorAll('input[name="provider"]')) {
    radio.checked = radio.value === current.provider;
  }
  fallbackToggle.checked = current.fallback;
  modelSearch.value = "";
  renderModels();
  settingsSheet.classList.add("is-open");
  settingsSheet.setAttribute("aria-hidden", "false");
  settingsSheet.inert = false;
  listView.inert = true;
  recordDock.inert = true;
  if (!models) loadModels();
}

function closeSettings() {
  if (!settingsSheet.classList.contains("is-open")) return;
  settingsSheet.classList.remove("is-open");
  settingsSheet.setAttribute("aria-hidden", "true");
  settingsSheet.inert = true;
  listView.inert = false;
  recordDock.inert = false;
  modelSearch.blur();
}

async function loadModels() {
  modelsFailed = false;
  try {
    const data = await api.listModels();
    models = Array.isArray(data?.models) ? data.models : [];
  } catch {
    modelsFailed = true;
  }
  renderModels();
}

// Rough cost of summarising a one-hour meeting (~15k tokens in, ~1k out).
function costLabel(m) {
  const dollars = (15000 * (m.prompt ?? 0) + 1000 * (m.completion ?? 0)) / 1e6;
  if (!dollars) return "kostenlos";
  const cents = dollars * 100;
  if (cents < 1) return "< 1 Cent/Std.";
  return `≈ ${cents < 10 ? cents.toFixed(1).replace(".", ",") : Math.round(cents)} Cent/Std.`;
}

function renderModels() {
  const current = settings.get().summaryModel;
  const known = models?.find((m) => m.id === current);
  summaryModelName.textContent = known ? `${known.name} · ${costLabel(known)}` : current;
  modelList.replaceChildren();
  if (!models) {
    modelList.append(el("p", "model-empty", modelsFailed ? "Modell-Liste nicht erreichbar" : "Lade Modelle …"));
    return;
  }
  const query = modelSearch.value.trim().toLowerCase();
  const hits = models
    .filter((m) => !query || m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query))
    .slice(0, 40);
  if (!hits.length) {
    modelList.append(el("p", "model-empty", "Kein Modell gefunden"));
    return;
  }
  for (const m of hits) {
    const item = el("button", "model-item");
    item.type = "button";
    item.dataset.id = m.id;
    item.classList.toggle("is-selected", m.id === current);
    item.append(el("span", undefined, m.name), el("small", undefined, costLabel(m)));
    modelList.append(item);
  }
}

settingsSheet.addEventListener("change", (event) => {
  if (event.target.name === "provider") settings.set({ provider: event.target.value });
  if (event.target === fallbackToggle) settings.set({ fallback: fallbackToggle.checked });
});

modelSearch.addEventListener("input", renderModels);

modelList.addEventListener("click", (event) => {
  const item = event.target.closest(".model-item");
  if (!item) return;
  settings.set({ summaryModel: item.dataset.id });
  renderModels();
  toast("Modell für Zusammenfassungen gespeichert");
});

settingsDone.addEventListener("click", closeSettings);

// ---------- Background retries ----------

pending.configure({
  apply: applyChunk,
  // Not while that note is being recorded or dictated into: the session owns its text then.
  skipNote: (noteId) => (recSession && noteId === recNoteId) || (dict && noteId === currentId),
  onChange: refreshBanner,
  onAccountProblem: (err) => toast(api.errorMessage(err), { duration: 5000 }),
});

meeting.configure({
  apply: applyMeeting,
  onChange: refreshBanner,
  onError: (m) => toast(m.lastError || "Meeting konnte nicht transkribiert werden", { duration: 5000 }),
});

// ---------- Lifecycle ----------

document.addEventListener("visibilitychange", () => {
  if (busy()) diag.log("visibility", { state: document.visibilityState });
  if (document.visibilityState !== "hidden") return;
  if (recSession || recMeeting) finishRecording("app hidden");
  if (dict) stopDictation();
  saveNow();
  backup.flush();
});

window.addEventListener("pagehide", () => {
  if (busy()) diag.log("pagehide");
  diag.flush();
  saveNow();
});

// ---------- Boot ----------

try {
  store.migrate();
} catch {}
renderList();
renderBackup();
backup.schedule(); // catch up on changes a closed app never uploaded
pending.startAuto();
meeting.startAuto();
navigator.storage?.persist?.().catch(() => {});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
