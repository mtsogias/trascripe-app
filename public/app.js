// Whisperflow PWA — single-file app logic

const $ = (sel) => document.querySelector(sel);
const els = {
  tabs: document.querySelectorAll(".tab"),
  transcribeView: $("#transcribeView"),
  notesView: $("#notesView"),
  recordBtn: $("#recordBtn"),
  copyAllBtn: $("#copyAllBtn"),
  clearBtn: $("#clearBtn"),
  transcript: $("#transcript"),
  status: $("#status"),
  waveCanvas: $("#waveCanvas"),
  notesList: $("#notesList"),
};

const NOTES_KEY = "whisperflow.notes.v1";
const DRAFT_KEY = "whisperflow.draft.v1";
const SEGMENT_MS = 10000;
const AUDIO_BITRATE = 64000;

// ---------- Tab switching ----------
els.tabs.forEach((t) => {
  t.addEventListener("click", () => {
    els.tabs.forEach((x) => x.classList.toggle("active", x === t));
    const tab = t.dataset.tab;
    els.transcribeView.classList.toggle("active", tab === "transcribe");
    els.notesView.classList.toggle("active", tab === "notes");
    if (tab === "notes") renderNotes();
    document.querySelector(".actions").style.visibility = (tab === "transcribe") ? "visible" : "hidden";
  });
});

// ---------- State ----------
let mediaRecorder = null;
let audioChunks = [];
let audioStream = null;
let audioCtx = null;
let analyser = null;
let waveRAF = null;
let isRecording = false;
let isLoading = false;
let wantRecording = false;
let finishing = false;
let wakeLock = null;
let recordStartTime = 0;
let recordTimerInterval = null;
let segmentTimer = null;
let sessionMime = "";
let sessionText = "";
let entryEl = null;
let chunkSeq = 0;
let nextToShow = 0;
let pendingResults = new Map();
let inflight = [];

// ---------- Wake Lock (keep screen awake) ----------
async function acquireWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch {}
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (isRecording || isLoading)) {
    acquireWakeLock();
  }
});

// ---------- Transcript view helpers ----------
let lastTranscript = "";

function fmtTime(d = new Date()) {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function renderEntry(text, { live } = {}) {
  if (text && text !== "…") lastTranscript = text;
  if (!entryEl || !els.transcript.contains(entryEl)) {
    els.transcript.innerHTML = "";
    entryEl = document.createElement("div");
    entryEl.className = "entry";
    const time = document.createElement("span");
    time.className = "time";
    const body = document.createElement("div");
    body.className = "entry-body";
    entryEl.appendChild(time);
    entryEl.appendChild(body);
    els.transcript.appendChild(entryEl);
  }
  entryEl.classList.toggle("live", !!live);
  entryEl.querySelector(".time").textContent = live ? `${fmtTime()} · Vorschau` : fmtTime();
  const body = entryEl.querySelector(".entry-body");
  const pinBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
  body.textContent = text || (live ? "…" : "");
  if (pinBottom) body.scrollTop = body.scrollHeight;
}

function getLastText() {
  return lastTranscript;
}

async function copyText(txt) {
  try {
    await navigator.clipboard.writeText(txt);
    flash("Kopiert ✓");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = txt; document.body.appendChild(ta);
    ta.select(); document.execCommand("copy"); ta.remove();
    flash("Kopiert ✓");
  }
}

els.copyAllBtn.addEventListener("click", async () => {
  const txt = getLastText();
  if (!txt) { flash("Nichts zu kopieren"); return; }
  await copyText(txt);
});

els.clearBtn.addEventListener("click", () => {
  if (isRecording || isLoading) { flash("Erst Aufnahme beenden"); return; }
  if (!lastTranscript && !sessionText) return;
  if (!confirm("Letzte Transkription löschen? (Gespeichert in Notes.)")) return;
  lastTranscript = "";
  sessionText = "";
  entryEl = null;
  els.transcript.innerHTML = "";
  clearDraft();
});

function flash(msg) {
  els.status.textContent = msg;
  setTimeout(() => { if (els.status.textContent === msg) els.status.textContent = ""; }, 2000);
}

function setRecordingTimer() {
  recordStartTime = Date.now();
  recordTimerInterval = setInterval(() => {
    const elapsed = (Date.now() - recordStartTime) / 1000;
    const extra = sessionText ? "" : " · Vorschau gleich";
    els.status.textContent = `Aufnahme… ${fmtDuration(elapsed)}${extra}`;
  }, 500);
}
function clearRecordingTimer() {
  if (recordTimerInterval) { clearInterval(recordTimerInterval); recordTimerInterval = null; }
}

// ---------- Draft (crash recovery) ----------
function saveDraft(text) {
  if (!text || !text.trim()) return;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ text, time: new Date().toISOString() }));
  } catch {}
}
function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); }
  catch { return null; }
}
function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
}
function recoverDraft() {
  const d = loadDraft();
  if (!d || !d.text || !d.text.trim()) return;
  sessionText = d.text;
  renderEntry(d.text, { live: false });
  archiveToNotes(d.text);
  clearDraft();
  flash("Zwischenspeicher wiederhergestellt");
}

// ---------- Notes (localStorage) ----------
function loadNotes() {
  try { return JSON.parse(localStorage.getItem(NOTES_KEY)) || []; }
  catch { return []; }
}
function saveNotes(n) { localStorage.setItem(NOTES_KEY, JSON.stringify(n)); }

function archiveToNotes(text) {
  if (!text || !text.trim()) return;
  const notes = loadNotes();
  notes.unshift({ id: Date.now() + "-" + Math.random().toString(36).slice(2,7), text, time: new Date().toISOString() });
  saveNotes(notes);
}

function renderNotes() {
  const notes = loadNotes();
  els.notesList.innerHTML = "";
  if (!notes.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Noch keine Notizen.";
    els.notesList.appendChild(empty);
    return;
  }
  notes.forEach((n) => {
    const el = document.createElement("div");
    el.className = "note";
    el.innerHTML = `
      <div class="note-meta">
        <span>${new Date(n.time).toLocaleString()}</span>
      </div>
      <div class="note-body"></div>
      <div class="note-actions">
        <button data-act="copy">Kopieren</button>
        <button data-act="delete">Löschen</button>
      </div>`;
    el.querySelector(".note-body").textContent = n.text;
    el.querySelector('[data-act="copy"]').addEventListener("click", async () => {
      await copyText(n.text);
    });
    el.querySelector('[data-act="delete"]').addEventListener("click", () => {
      if (!confirm("Diese Notiz löschen?")) return;
      const all = loadNotes().filter((x) => x.id !== n.id);
      saveNotes(all);
      renderNotes();
      flash("Gelöscht");
    });
    els.notesList.appendChild(el);
  });
}

// ---------- Recording ----------
els.recordBtn.addEventListener("click", toggleRecord);

async function toggleRecord() {
  if (isLoading) return;
  if (isRecording) {
    stopRecording();
  } else {
    await startRecording();
  }
}

function pickMime() {
  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isiOS && MediaRecorder.isTypeSupported("audio/mp4")) return "audio/mp4";
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
  if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
  if (MediaRecorder.isTypeSupported("audio/mp4")) return "audio/mp4";
  return "";
}

async function startRecording() {
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    flash("Mikrofon-Zugriff verweigert");
    return;
  }

  await acquireWakeLock();

  sessionMime = pickMime();
  sessionText = "";
  lastTranscript = "";
  entryEl = null;
  chunkSeq = 0;
  nextToShow = 0;
  pendingResults = new Map();
  inflight = [];
  finishing = false;
  wantRecording = true;
  isRecording = true;

  renderEntry("", { live: true });
  els.recordBtn.classList.add("recording");
  els.recordBtn.setAttribute("aria-label", "Aufnahme beenden");
  setRecordingTimer();
  startWaveform();
  startSegment();
}

function startSegment() {
  if (!audioStream || !wantRecording) return;
  audioChunks = [];
  const opts = { audioBitsPerSecond: AUDIO_BITRATE };
  if (sessionMime) opts.mimeType = sessionMime;
  try {
    mediaRecorder = new MediaRecorder(audioStream, opts);
  } catch {
    mediaRecorder = new MediaRecorder(audioStream);
  }
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) audioChunks.push(e.data); };
  mediaRecorder.onstop = onSegmentStop;
  mediaRecorder.onerror = (e) => {
    console.error("MediaRecorder error:", e);
    flash("Aufnahme-Fehler");
    wantRecording = false;
    isRecording = false;
    try { if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop(); } catch {}
  };
  mediaRecorder.start(1000);
  clearTimeout(segmentTimer);
  segmentTimer = setTimeout(() => {
    if (wantRecording && mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }
  }, SEGMENT_MS);
}

function cleanupRecording() {
  wantRecording = false;
  isRecording = false;
  isLoading = false;
  finishing = false;
  clearTimeout(segmentTimer);
  segmentTimer = null;
  clearRecordingTimer();
  stopWaveform();
  els.recordBtn.classList.remove("recording", "loading");
  els.recordBtn.setAttribute("aria-label", "Aufnahme starten");
  els.status.textContent = "";
  releaseWakeLock();
  if (audioStream) {
    audioStream.getTracks().forEach((t) => t.stop());
    audioStream = null;
  }
  mediaRecorder = null;
}

function stopRecording() {
  if (!isRecording && !wantRecording) return;
  wantRecording = false;
  isRecording = false;
  clearTimeout(segmentTimer);
  segmentTimer = null;
  clearRecordingTimer();
  els.recordBtn.classList.remove("recording");
  els.recordBtn.classList.add("loading");
  isLoading = true;
  els.status.textContent = inflight.length ? `Transkribiere… (${inflight.length})` : "Transkribiere…";
  stopWaveform();
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  } else {
    finishSession();
  }
}

function onSegmentStop() {
  const mimeType = (mediaRecorder && mediaRecorder.mimeType) || sessionMime || "audio/webm";
  const blob = new Blob(audioChunks, { type: mimeType });
  audioChunks = [];
  const keepGoing = wantRecording;

  if (keepGoing) {
    setTimeout(() => {
      if (wantRecording && audioStream) startSegment();
    }, 50);
  }

  if (blob.size >= 200) {
    transcribeSegment(blob, mimeType, chunkSeq++);
  } else if (!keepGoing && chunkSeq === 0 && !sessionText) {
    flash("Aufnahme zu kurz");
    cleanupRecording();
    return;
  }

  if (!keepGoing) finishSession();
}

function transcribeSegment(blob, mimeType, seq) {
  const p = (async () => {
    try {
      const text = await transcribeBlob(blob, mimeType);
      pendingResults.set(seq, text || "");
    } catch (e) {
      console.error("Transcribe error:", e);
      pendingResults.set(seq, "");
      flash("Stück fehlgeschlagen, Aufnahme läuft weiter");
    }
    flushPreview();
  })();
  inflight.push(p);
  p.finally(() => {
    inflight = inflight.filter((x) => x !== p);
  });
}

function flushPreview() {
  while (pendingResults.has(nextToShow)) {
    const t = pendingResults.get(nextToShow);
    pendingResults.delete(nextToShow);
    nextToShow++;
    if (!t) continue;
    sessionText = sessionText ? `${sessionText} ${t}` : t;
    lastTranscript = sessionText;
    const stillLive = wantRecording || isRecording || inflight.length > 0 || !finishing;
    renderEntry(sessionText, { live: stillLive });
    saveDraft(sessionText);
  }
}

async function finishSession() {
  if (finishing) return;
  finishing = true;
  isLoading = true;
  while (inflight.length) {
    els.status.textContent = `Transkribiere… (${inflight.length})`;
    await Promise.all([...inflight]);
  }
  flushPreview();
  const text = (sessionText || "").trim();
  if (text) {
    renderEntry(text, { live: false });
    archiveToNotes(text);
    clearDraft();
    cleanupRecording();
  } else {
    cleanupRecording();
    flash("Leere Transkription");
  }
}

async function transcribeBlob(blob, mimeType) {
  const b64 = await blobToBase64(blob);
  const payload = JSON.stringify({ audio: b64, mime: mimeType || blob.type || "audio/webm" });
  return transcribeWithRetry(payload);
}

async function transcribeWithRetry(payload, attempt = 1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: controller.signal,
    });
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return (data.text || "").trim();
  } catch (err) {
    if (err.name === "AbortError" && attempt < 2) {
      return transcribeWithRetry(payload, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(r.result.split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// ---------- Waveform bars (above record button) ----------
function startWaveform() {
  els.waveCanvas.classList.add("active");
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  try {
    const source = audioCtx.createMediaStreamSource(audioStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.45;
    source.connect(analyser);
  } catch (e) {
    console.error("Waveform init error:", e);
    return;
  }
  const buffer = new Uint8Array(analyser.fftSize);
  const ctx = els.waveCanvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const bars = 15;
  const levels = new Float32Array(bars);
  const GAIN = 2;
  function resize() {
    const r = els.waveCanvas.getBoundingClientRect();
    els.waveCanvas.width = r.width * dpr;
    els.waveCanvas.height = r.height * dpr;
  }
  resize();
  function draw() {
    if (!analyser) return;
    analyser.getByteTimeDomainData(buffer);
    const w = els.waveCanvas.width, h = els.waveCanvas.height;
    const gap = 4 * dpr;
    const barW = Math.max(3 * dpr, (w - gap * (bars - 1)) / bars);
    const slice = Math.floor(buffer.length / bars);
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < bars; i++) {
      let peak = 0;
      const start = i * slice;
      for (let j = 0; j < slice; j++) {
        const v = Math.abs(buffer[start + j] - 128) / 128;
        if (v > peak) peak = v;
      }
      const boosted = Math.min(1, peak * GAIN);
      levels[i] += (boosted - levels[i]) * 0.42;
      const minH = 6 * dpr;
      const maxH = h * 0.92;
      const barH = minH + levels[i] * (maxH - minH);
      const x = i * (barW + gap) + barW / 2;
      const y1 = (h - barH) / 2;
      const y2 = y1 + barH;
      ctx.beginPath();
      ctx.lineWidth = barW;
      ctx.lineCap = "round";
      ctx.strokeStyle = "rgba(255,255,255,0.88)";
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
      ctx.stroke();
    }
    waveRAF = requestAnimationFrame(draw);
  }
  draw();
}

function stopWaveform() {
  if (waveRAF) cancelAnimationFrame(waveRAF);
  waveRAF = null;
  els.waveCanvas.classList.remove("active");
  const ctx = els.waveCanvas.getContext("2d");
  ctx && ctx.clearRect(0, 0, els.waveCanvas.width, els.waveCanvas.height);
}

// ---------- Handle page freeze / visibility ----------
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") return;
  if (isRecording) stopRecording();
});

// ---------- Service worker for offline shell ----------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

recoverDraft();
