// Whisperflow PWA — single-file app logic

const $ = (sel) => document.querySelector(sel);
const els = {
  tabs: document.querySelectorAll(".tab"),
  transcribeView: $("#transcribeView"),
  notesView: $("#notesView"),
  recordBtn: $("#recordBtn"),
  stopBtn: $("#stopBtn"),
  copyAllBtn: $("#copyAllBtn"),
  clearBtn: $("#clearBtn"),
  transcript: $("#transcript"),
  status: $("#status"),
  waveCanvas: $("#waveCanvas"),
  notesList: $("#notesList"),
};

const NOTES_KEY = "whisperflow.notes.v1";

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
let wakeLock = null;
let recordStartTime = 0;
let recordTimerInterval = null;

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
// Re-acquire on visibility change (iOS sometimes drops it)
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

function addEntry(text) {
  lastTranscript = text;
  els.transcript.innerHTML = "";
  const div = document.createElement("div");
  div.className = "entry";
  div.addEventListener("click", () => div.classList.toggle("expanded"));
  const t = document.createElement("span");
  t.className = "time";
  t.textContent = fmtTime();
  const body = document.createElement("span");
  body.className = "entry-body";
  body.textContent = text;
  div.appendChild(t);
  div.appendChild(body);
  els.transcript.appendChild(div);
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
  if (!lastTranscript) return;
  if (!confirm("Letzte Transkription löschen? (Gespeichert in Notes.)")) return;
  lastTranscript = "";
  els.transcript.innerHTML = "";
});

function flash(msg) {
  els.status.textContent = msg;
  setTimeout(() => { if (els.status.textContent === msg) els.status.textContent = ""; }, 2000);
}

function setRecordingTimer() {
  recordStartTime = Date.now();
  recordTimerInterval = setInterval(() => {
    const elapsed = (Date.now() - recordStartTime) / 1000;
    els.status.textContent = `Aufnahme… ${fmtDuration(elapsed)}`;
  }, 500);
}
function clearRecordingTimer() {
  if (recordTimerInterval) { clearInterval(recordTimerInterval); recordTimerInterval = null; }
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
els.stopBtn.addEventListener("click", () => { if (isRecording) stopRecording(); });

async function toggleRecord() {
  if (isLoading) return;
  if (isRecording) {
    stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    flash("Mikrofon-Zugriff verweigert");
    return;
  }

  await acquireWakeLock();

  // pick mime that iOS supports
  let mime = "audio/webm";
  if (!MediaRecorder.isTypeSupported(mime)) {
    mime = "audio/mp4";
    if (!MediaRecorder.isTypeSupported(mime)) mime = "";
  }
  try {
    mediaRecorder = mime ? new MediaRecorder(audioStream, { mimeType: mime }) : new MediaRecorder(audioStream);
  } catch {
    mediaRecorder = new MediaRecorder(audioStream);
  }
  audioChunks = [];
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) audioChunks.push(e.data); };
  mediaRecorder.onstop = onRecordStop;
  mediaRecorder.onerror = (e) => {
    console.error("MediaRecorder error:", e);
    flash("Aufnahme-Fehler");
    cleanupRecording();
  };

  // chunk every 1s so we don't lose everything if iOS freezes the page
  mediaRecorder.start(1000);
  isRecording = true;
  els.recordBtn.classList.add("recording");
  els.stopBtn.hidden = false;
  setRecordingTimer();
  startWaveform();
}

function cleanupRecording() {
  isRecording = false;
  isLoading = false;
  clearRecordingTimer();
  stopWaveform();
  els.recordBtn.classList.remove("recording", "loading");
  els.stopBtn.hidden = true;
  els.status.textContent = "";
  releaseWakeLock();
  if (audioStream) {
    audioStream.getTracks().forEach((t) => t.stop());
    audioStream = null;
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  } else {
    // recorder already stopped or in weird state — cleanup
    cleanupRecording();
    return;
  }
  isRecording = false;
  clearRecordingTimer();
  els.recordBtn.classList.remove("recording");
  els.stopBtn.hidden = true;
  els.recordBtn.classList.add("loading");
  els.status.textContent = "Transkribiere…";
  stopWaveform();
}

async function onRecordStop() {
  if (audioStream) {
    audioStream.getTracks().forEach((t) => t.stop());
  }
  const mimeType = (mediaRecorder && mediaRecorder.mimeType) || "audio/webm";
  const blob = new Blob(audioChunks, { type: mimeType });
  audioChunks = [];

  if (!blob.size || blob.size < 200) {
    flash("Aufnahme zu kurz");
    cleanupRecording();
    return;
  }

  isLoading = true;
  try {
    const b64 = await blobToBase64(blob);
    const payload = JSON.stringify({ audio: b64, mime: mimeType });
    const text = await transcribeWithRetry(payload);
    if (text) {
      addEntry(text);
      archiveToNotes(text);
    } else {
      flash("Leere Transkription");
    }
  } catch (e) {
    console.error("Transcribe error:", e);
    flash("Fehler: " + (e.message || e));
  } finally {
    isLoading = false;
    cleanupRecording();
  }
}

async function transcribeWithRetry(payload, attempt = 1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return (data.text || "").trim();
  } catch (err) {
    if (err.name === "AbortError" && attempt < 2) {
      // retry once
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

// ---------- Waveform ring ----------
function startWaveform() {
  els.waveCanvas.classList.add("active");
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  try {
    const source = audioCtx.createMediaStreamSource(audioStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
  } catch (e) {
    console.error("Waveform init error:", e);
    return;
  }
  const buffer = new Uint8Array(analyser.frequencyBinCount);
  const ctx = els.waveCanvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  function resize() {
    const r = els.waveCanvas.getBoundingClientRect();
    els.waveCanvas.width = r.width * dpr;
    els.waveCanvas.height = r.height * dpr;
  }
  resize();
  const bars = 64;
  let phase = 0;
  function draw() {
    analyser.getByteFrequencyData(buffer);
    const w = els.waveCanvas.width, h = els.waveCanvas.height;
    const cx = w / 2, cy = h / 2;
    const radius = Math.min(w, h) * 0.34;
    ctx.clearRect(0, 0, w, h);
    phase += 0.02;
    for (let i = 0; i < bars; i++) {
      const v = buffer[i % buffer.length] / 255;
      const len = 4 + v * radius * 0.45;
      const ang = (i / bars) * Math.PI * 2 + phase;
      const x1 = cx + Math.cos(ang) * radius;
      const y1 = cy + Math.sin(ang) * radius;
      const x2 = cx + Math.cos(ang) * (radius + len);
      const y2 = cy + Math.sin(ang) * (radius + len);
      ctx.strokeStyle = `rgba(110,168,254,${0.35 + v * 0.6})`;
      ctx.lineWidth = 2 * dpr;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
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
// If the page was hidden during recording and comes back, stop gracefully
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") return;
  // page hidden
  if (isRecording) {
    // try to stop recording cleanly — iOS may allow a brief window
    try { if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop(); } catch {}
  }
});

// ---------- Service worker for offline shell ----------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}