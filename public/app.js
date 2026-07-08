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

// ---------- Tab switching ----------
els.tabs.forEach((t) => {
  t.addEventListener("click", () => {
    els.tabs.forEach((x) => x.classList.toggle("active", x === t));
    const tab = t.dataset.tab;
    els.transcribeView.classList.toggle("active", tab === "transcribe");
    els.notesView.classList.toggle("active", tab === "notes");
    if (tab === "notes") renderNotes();
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

// ---------- Transcript view helpers ----------
function fmtTime(d = new Date()) {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function addEntry(text) {
  const div = document.createElement("div");
  div.className = "entry";
  const t = document.createElement("span");
  t.className = "time";
  t.textContent = fmtTime();
  const body = document.createTextNode(text);
  div.appendChild(t);
  div.appendChild(body);
  els.transcript.appendChild(div);
  els.transcript.parentElement.scrollTop = els.transcript.parentElement.scrollHeight;
}

function getAllText() {
  return [...els.transcript.querySelectorAll(".entry")]
    .map((e) => e.textContent.replace(/^\d\d:\d\d\s*/, "").trim())
    .join("\n\n");
}

els.copyAllBtn.addEventListener("click", async () => {
  const txt = getAllText();
  if (!txt) { flash("Nichts zu kopieren"); return; }
  try {
    await navigator.clipboard.writeText(txt);
    flash("Kopiert ✓");
  } catch {
    // iOS fallback
    const ta = document.createElement("textarea");
    ta.value = txt; document.body.appendChild(ta);
    ta.select(); document.execCommand("copy"); ta.remove();
    flash("Kopiert ✓");
  }
});

els.clearBtn.addEventListener("click", () => {
  if (!els.transcript.children.length) return;
  if (!confirm("Aktuelle Transkriptionen löschen? (Alte sind in Notes gespeichert.)")) return;
  els.transcript.innerHTML = "";
});

function flash(msg) {
  els.status.textContent = msg;
  setTimeout(() => { if (els.status.textContent === msg) els.status.textContent = ""; }, 1600);
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
      try { await navigator.clipboard.writeText(n.text); flash("Kopiert ✓"); }
      catch {
        const ta = document.createElement("textarea");
        ta.value = n.text; document.body.appendChild(ta);
        ta.select(); document.execCommand("copy"); ta.remove();
        flash("Kopiert ✓");
      }
    });
    el.querySelector('[data-act="delete"]').addEventListener("click", () => {
      const all = loadNotes().filter((x) => x.id !== n.id);
      saveNotes(all);
      renderNotes();
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

async function startRecording() {
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    flash("Mikrofon-Zugriff verweigert");
    return;
  }

  // pick mime that iOS supports
  let mime = "audio/webm";
  if (!MediaRecorder.isTypeSupported(mime)) {
    mime = "audio/mp4";
    if (!MediaRecorder.isTypeSupported(mime)) mime = "";
  }
  mediaRecorder = mime ? new MediaRecorder(audioStream, { mimeType: mime }) : new MediaRecorder(audioStream);
  audioChunks = [];
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) audioChunks.push(e.data); };
  mediaRecorder.onstop = onRecordStop;

  mediaRecorder.start();
  isRecording = true;
  els.recordBtn.classList.add("recording");
  els.status.textContent = "Aufnahme…";
  startWaveform();
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
  isRecording = false;
  els.recordBtn.classList.remove("recording");
  els.recordBtn.classList.add("loading");
  els.status.textContent = "Transkribiere…";
  stopWaveform();
}

async function onRecordStop() {
  audioStream?.getTracks().forEach((t) => t.stop());
  const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
  audioChunks = [];
  try {
    const b64 = await blobToBase64(blob);
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio: b64, mime: blob.type }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Transcribe failed");
    const text = (data.text || "").trim();
    if (text) {
      addEntry(text);
      archiveToNotes(text);
    } else {
      flash("Leere Transkription");
    }
  } catch (e) {
    console.error(e);
    flash("Fehler: " + (e.message || e));
  } finally {
    els.recordBtn.classList.remove("loading");
    els.status.textContent = "";
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
  const source = audioCtx.createMediaStreamSource(audioStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
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

// ---------- Service worker for offline shell (optional) ----------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}