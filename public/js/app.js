// Whisperflow UI: note list, editor, recording sheet and dictation into the editor.
import * as store from "./store.js";
import { TranscriptionSession } from "./session.js";
import { createWaveform } from "./waveform.js";

const $ = (sel) => document.querySelector(sel);

const app = $("#app");
const listView = $("#listView");
const editorView = $("#editorView");
const searchInput = $("#searchInput");
const notesList = $("#notesList");
const emptyState = $("#emptyState");
const backBtn = $("#backBtn");
const copyBtn = $("#copyBtn");
const shareBtn = $("#shareBtn");
const deleteBtn = $("#deleteBtn");
const editorMeta = $("#editorMeta");
const editorText = $("#editorText");
const dictateBtn = $("#dictateBtn");
const dictateBar = $(".dictate-bar");
const dictateWaveform = createWaveform($("#dictateWave"));
const recordBtn = $("#recordBtn");
const recordSheet = $("#recordSheet");
const recordTimer = $("#recordTimer");
const liveText = $("#liveText");
const recordStatus = $("#recordStatus");
const recordWaveform = createWaveform($("#recordWave"));
const stopBtn = $("#stopBtn");
const toastEl = $("#toast");
const toastText = $("#toastText");
const toastAction = $("#toastAction");

const DAY_MS = 86400000;
const TIME_FMT = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });
const DAY_FMT = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short" });
const DAY_YEAR_FMT = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", year: "numeric" });
const FULL_DATE_FMT = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long", year: "numeric" });
const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const START_ERRORS = {
  "mic-denied": "Mikrofon-Zugriff verweigert",
  "no-mic": "Kein Mikrofon gefunden",
  unsupported: "Aufnahme wird nicht unterstützt",
};
const CHUNK_ERROR = "Ein Abschnitt konnte nicht transkribiert werden";

let recSession = null;     // active recording session
let recNoteId = null;      // note created for the current recording
let recFinishing = false;
let dict = null;           // active dictation: { session, before, after, prefix, suffix, stopping }
let currentId = null;      // note open in the editor
let leaving = false;       // editor is closing (waiting for dictation to stop)
let saveTimer = null;
let timerId = null;
let startedAt = 0;
let wakeLock = null;
let toastTimer = null;

const busy = () => recSession !== null || dict !== null;

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
  } catch {}
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function autosize() {
  editorText.style.height = "auto";
  editorText.style.height = `${editorText.scrollHeight}px`;
}

// ---------- List view ----------

function noteCard(note) {
  const card = el("article", "note-card");
  card.dataset.id = note.id;

  const open = el("button", "note-open");
  open.type = "button";
  const time = el("time", "note-time", relTime(note.updatedAt));
  time.dateTime = note.updatedAt;
  const meta = el("p", "note-meta");
  meta.append(time, el("span", "note-dot", "·"), el("span", "note-words", wordLabel(note.text)));
  open.append(el("p", "note-preview", note.text), meta);

  const copy = el("button", "note-copy icon-btn");
  copy.type = "button";
  copy.setAttribute("aria-label", "Kopieren");
  copy.innerHTML = COPY_ICON;

  card.append(open, copy);
  return card;
}

function renderList() {
  const all = store.listNotes();
  const query = searchInput.value.trim().toLowerCase();
  const notes = query ? all.filter((n) => n.text.toLowerCase().includes(query)) : all;

  emptyState.hidden = all.length > 0;
  notesList.replaceChildren();
  if (all.length > 0 && notes.length === 0) {
    notesList.append(el("p", "empty-text", "Keine Treffer"));
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
    notesList.append(noteCard(note));
  }
}

notesList.addEventListener("click", (event) => {
  const card = event.target.closest(".note-card");
  if (!card) return;
  if (event.target.closest(".note-copy")) {
    const note = store.getNote(card.dataset.id);
    copyText(note ? note.text : "");
  } else if (event.target.closest(".note-open")) {
    openEditor(card.dataset.id);
  }
});

searchInput.addEventListener("input", renderList);

// ---------- Recording (new note) ----------

function openSheet() {
  liveText.textContent = "";
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

async function startRecording() {
  if (busy()) return;
  openSheet();
  const session = new TranscriptionSession({
    onText: (full) => onRecordingText(session, full),
    onState: (state) => onRecordingState(session, state),
    onError: (err, kind) => onRecordingError(session, kind),
  });
  recSession = session;
  try {
    await session.start();
  } catch (err) {
    // Stopped while starting: finishRecording owns the cleanup and toast.
    if (session !== recSession || recFinishing) return;
    recSession = null;
    closeSheet();
    toast(startErrorMessage(err));
    return;
  }
  recordWaveform.start(session.analyser);
  startTimer();
  holdWakeLock();
}

function onRecordingText(session, full) {
  if (session !== recSession) return;
  liveText.textContent = full;
  liveText.scrollTop = liveText.scrollHeight;
  // Persist as we go so a crash mid-recording keeps the text.
  if (recNoteId) {
    safe(() => store.updateNote(recNoteId, full));
  } else {
    recNoteId = safe(() => store.createNote(full))?.id ?? null;
  }
}

function onRecordingState(session, { phase, pending }) {
  if (session !== recSession || phase !== "finishing") return;
  recordStatus.textContent = pending ? `Transkribiere … (${pending})` : "Transkribiere …";
}

function onRecordingError(session, kind) {
  if (session !== recSession) return;
  if (kind === "fatal") finishRecording();
  else toast(CHUNK_ERROR);
}

async function finishRecording() {
  const session = recSession;
  if (!session || recFinishing) return;
  recFinishing = true;
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

  if (text) {
    let id = noteId;
    if (id) safe(() => store.updateNote(id, text));
    else id = safe(() => store.createNote(text))?.id ?? null;
    renderList();
    if (id) openEditor(id);
  } else {
    if (noteId) safe(() => store.deleteNote(noteId));
    renderList();
    toast("Nichts erkannt");
  }
}

recordBtn.addEventListener("click", startRecording);
stopBtn.addEventListener("click", finishRecording);

// ---------- Editor ----------

function openEditor(id) {
  const note = store.getNote(id);
  if (!note) {
    renderList();
    return;
  }
  currentId = id;
  editorText.value = note.text;
  editorMeta.textContent = fullDate(note.createdAt);
  autosize();
  editorView.scrollTop = 0;
  app.dataset.view = "editor";
  listView.inert = true;
  editorView.classList.add("is-active");
  editorView.setAttribute("aria-hidden", "false");
  editorView.inert = false;
}

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
const EDGE_PX = 28;
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
  if (event.key === "Escape") closeEditor();
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
  if (deleted) {
    toast("Notiz gelöscht", {
      actionLabel: "Widerrufen",
      duration: 5000,
      onAction: () => {
        safe(() => store.restoreNote(deleted));
        renderList();
      },
    });
  }
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
  d.session = new TranscriptionSession({
    onText: (full) => {
      if (dict !== d) return;
      editorText.value = before + (full ? prefix + full + suffix : "") + after;
      autosize();
      scheduleSave();
    },
    onState: () => {},
    onError: (err, kind) => {
      if (dict !== d) return;
      if (kind === "fatal") stopDictation();
      else toast(CHUNK_ERROR);
    },
  });

  dict = d;
  editorText.readOnly = true;
  dictateBtn.classList.add("is-active");
  dictateBtn.setAttribute("aria-label", "Diktat beenden");
  dictateBar.classList.add("is-active");
  try {
    await d.session.start();
  } catch (err) {
    // Stopped while starting: finishDictation owns the cleanup and toast.
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
  if (!full) toast("Nichts erkannt");
}

// ---------- Lifecycle ----------

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  if (recSession) finishRecording();
  if (dict) stopDictation();
  saveNow();
});

window.addEventListener("pagehide", saveNow);

// ---------- Boot ----------

try {
  store.migrate();
} catch {}
renderList();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
