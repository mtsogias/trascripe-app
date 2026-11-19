// Meeting mode: records the whole meeting on the device (IMA ADPCM WAV in IndexedDB, saved every few
// seconds), then sends it to MAI-Transcribe 2 with speaker detection and turns the result into the note.
// Long meetings are split into files of FILE_SEC that overlap by OVERLAP_SEC (see meeting-merge.js).
//
// Meeting record (IndexedDB "meetings"):
//   { id, noteId, startedAt, status: "recording" | "queued" | "failed", lang,
//     files: [{ index, start, end, samples, blocks, pieces, result? }], attempts, nextAt, lastCode, lastError }
// Audio rows (IndexedDB "audio"): { meetingId, file, n, bytes }
import { Recorder } from "./recorder.js";
import { AdpcmEncoder, BLOCK_ALIGN, SAMPLES_PER_BLOCK, adpcmWavHeader } from "./adpcm.js";
import { mergeFiles, formatTranscript } from "./meeting-merge.js";
import * as idb from "./idb.js";
import * as api from "./api.js";
import * as diag from "./diag.js";

const SAMPLE_RATE = 16000;
const FILE_SEC = 30 * 60; // ~14.5 MB per file, below the provider's 25 MB request limit
const OVERLAP_SEC = 90;
const SAVE_EVERY_MS = 5000;
const PIECE_BYTES = 3.5 * 1024 * 1024; // Vercel request bodies are capped at ~4.5 MB
const TICK_MS = 60000;
const BACKOFF_BASE_MS = 60000;
const BACKOFF_MAX_MS = 30 * 60000;

export const PLACEHOLDER = "⏳ Meeting wird transkribiert …";

const newId = () => (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

// ---------- Recording ----------

export class MeetingRecording {
  constructor({ noteId, onError } = {}) {
    this.id = newId();
    this.noteId = noteId;
    this._onError = onError;
    this._recorder = null;
    this._ring = new Float32Array(OVERLAP_SEC * SAMPLE_RATE); // last OVERLAP_SEC of audio
    this._ringPos = 0;
    this._ringFull = false;
    this._total = 0; // samples since start
    this._files = [];
    this._file = null; // { meta, encoder, buffered: Uint8Array[], n }
    this._saveTimer = null;
    this._saving = Promise.resolve();
    this._failedSave = false;
  }

  get analyser() {
    return this._recorder?.analyser ?? null;
  }

  get durationSec() {
    return this._total / SAMPLE_RATE;
  }

  async start() {
    this._recorder = new Recorder({
      onSegment: () => {}, // speech detection only feeds the diagnostics log here
      onPcm: (pcm) => this._onPcm(pcm),
      onError: (err) => {
        diag.log("fatal", { err: err?.message });
        this._onError?.(err);
      },
    });
    this._openFile(0, new Float32Array(0));
    await idb.put("meetings", this._record("recording"));
    await this._recorder.start();
    this._saveTimer = setInterval(() => this._save(), SAVE_EVERY_MS);
    diag.log("meeting start", { id: this.id });
  }

  // Stops and leaves everything queued for transcription. Returns the meeting id.
  async stop() {
    clearInterval(this._saveTimer);
    await this._recorder?.stop(); // flushes the last samples through onPcm
    this._closeFile();
    this._save();
    await this._saving;
    await idb.put("meetings", this._record("queued"));
    diag.log("meeting stop", { id: this.id, sec: Math.round(this.durationSec), files: this._files.length });
    return this.id;
  }

  _record(status) {
    return {
      id: this.id,
      noteId: this.noteId,
      startedAt: this._startedAt ??= Date.now(),
      status,
      lang: null,
      files: this._files.map(({ index, start, end, samples, blocks }) => ({ index, start, end, samples, blocks })),
      attempts: 0,
      nextAt: 0,
    };
  }

  _openFile(index, preroll) {
    const startSample = this._total - preroll.length;
    const meta = { index, start: startSample / SAMPLE_RATE, end: startSample / SAMPLE_RATE, samples: 0, blocks: 0 };
    this._files.push(meta);
    this._file = { meta, encoder: new AdpcmEncoder(), buffered: [], n: 0 };
    if (preroll.length) this._encode(preroll);
  }

  _closeFile() {
    const f = this._file;
    if (!f) return;
    const tail = f.encoder.flush();
    if (tail.length) f.buffered.push(tail);
    f.meta.blocks += tail.length / BLOCK_ALIGN;
  }

  _encode(pcm) {
    const f = this._file;
    const bytes = f.encoder.push(pcm);
    if (bytes.length) f.buffered.push(bytes);
    f.meta.blocks += bytes.length / BLOCK_ALIGN;
    f.meta.samples += pcm.length;
    f.meta.end = f.meta.start + f.meta.samples / SAMPLE_RATE;
  }

  _onPcm(pcm) {
    this._total += pcm.length;
    this._encode(pcm);
    this._remember(pcm);
    if (this._file.meta.samples >= FILE_SEC * SAMPLE_RATE) {
      // Next file starts with the last OVERLAP_SEC, so speakers can be matched across files.
      const preroll = this._overlap();
      this._closeFile();
      this._save();
      this._openFile(this._files.length, preroll);
      diag.log("meeting next file", { index: this._files.length - 1 });
    }
  }

  _remember(pcm) {
    const ring = this._ring;
    for (let i = 0; i < pcm.length; i++) {
      ring[this._ringPos++] = pcm[i];
      if (this._ringPos === ring.length) {
        this._ringPos = 0;
        this._ringFull = true;
      }
    }
  }

  _overlap() {
    if (!this._ringFull) return this._ring.slice(0, this._ringPos);
    const out = new Float32Array(this._ring.length);
    out.set(this._ring.subarray(this._ringPos));
    out.set(this._ring.subarray(0, this._ringPos), this._ring.length - this._ringPos);
    return out;
  }

  // Writes everything encoded since the last save, for every file that has new audio.
  _save() {
    const writes = [];
    const f = this._file;
    if (f?.buffered.length) {
      const bytes = concat(f.buffered);
      f.buffered = [];
      writes.push({ meetingId: this.id, file: f.meta.index, n: f.n++, bytes });
    }
    const record = this._record("recording");
    this._saving = this._saving
      .then(async () => {
        for (const row of writes) await idb.put("audio", row);
        await idb.put("meetings", record);
        this._failedSave = false;
      })
      .catch((err) => {
        diag.log("meeting save failed", { err: String(err) });
        if (!this._failedSave) this._onError?.(Object.assign(new Error("save"), { code: "storage" }));
        this._failedSave = true;
      });
  }
}

function concat(parts) {
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------- Transcription queue ----------

let hooks = { apply: () => true, onChange: () => {}, onError: () => {} };
const activeIds = new Set(); // meetings being recorded in this tab
let running = null;
let again = false; // a meeting was queued while a run was going: run once more afterwards

export function configure(h) {
  hooks = { ...hooks, ...h };
}

export function markActive(id, on) {
  if (on) activeIds.add(id);
  else activeIds.delete(id);
}

async function all() {
  try {
    return await idb.getAll("meetings");
  } catch {
    return [];
  }
}

// Meetings that are not done yet, by note id: { status, lastCode, lastError }.
export async function statusByNote() {
  const map = new Map();
  for (const m of await all()) {
    if (activeIds.has(m.id)) continue;
    map.set(m.noteId, { status: running?.id === m.id ? "processing" : m.status, lastCode: m.lastCode, lastError: m.lastError });
  }
  return map;
}

export async function forget(noteId) {
  for (const m of await all()) {
    if (m.noteId !== noteId || activeIds.has(m.id)) continue;
    await idb.removeMeetingAudio(m.id).catch(() => {});
    await idb.remove("meetings", m.id).catch(() => {});
    api.meetingDiscard(m.id);
  }
  hooks.onChange();
}

export function retry({ force = false, wake = false, noteId = null } = {}) {
  if (running) {
    again = true;
    return running.promise;
  }
  const promise = (async () => {
    const now = Date.now();
    const due = (await all())
      .filter((m) => !activeIds.has(m.id) && (!noteId || m.noteId === noteId))
      .filter((m) => force || m.status !== "failed" || m.nextAt <= now || (wake && ["network", "timeout"].includes(m.lastCode)))
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const m of due) {
      running = { id: m.id, promise };
      hooks.onChange();
      const result = await processMeeting(m);
      if (!result.ok && force) hooks.onError(result.meeting);
    }
  })().finally(() => {
    running = null;
    hooks.onChange();
    if (again) {
      again = false;
      retry();
    }
  });
  running = { id: null, promise };
  return promise;
}

async function buildFile(meeting, file) {
  const rows = (await idb.meetingAudio(meeting.id)).filter((r) => r.file === file.index);
  const body = concat(rows.map((r) => r.bytes));
  const blocks = Math.floor(body.length / BLOCK_ALIGN);
  const samples = file.samples || blocks * SAMPLES_PER_BLOCK;
  return concat([adpcmWavHeader(blocks, samples), body.subarray(0, blocks * BLOCK_ALIGN)]);
}

async function transcribeFile(meeting, file) {
  const wav = await buildFile(meeting, file);
  if (wav.length <= 60) return []; // no audio in this file
  const pieces = Math.ceil(wav.length / PIECE_BYTES);
  for (let attempt = 0; ; attempt++) {
    for (let p = 0; p < pieces; p++) {
      await api.meetingUpload(meeting.id, file.index, p, wav.subarray(p * PIECE_BYTES, (p + 1) * PIECE_BYTES));
    }
    try {
      const result = await api.meetingTranscribe(meeting.id, file.index, pieces, meeting.lang);
      return Array.isArray(result?.segments) ? result.segments : [];
    } catch (err) {
      // The server deletes pieces after every attempt; one more upload covers a lost piece.
      if (err.code !== "missing" || attempt > 0) throw err;
    }
  }
}

async function processMeeting(m) {
  // A meeting still "recording" that this tab does not record crashed: what was saved is all there is.
  const meeting = { ...m, status: m.status === "recording" ? "queued" : m.status };
  try {
    for (const file of meeting.files) {
      if (file.result) continue;
      file.result = await transcribeFile(meeting, file);
      await idb.put("meetings", meeting); // keep finished files across retries
      diag.log("meeting file done", { id: meeting.id, file: file.index, segments: file.result.length });
    }
    const merged = mergeFiles(meeting.files.map((f) => ({ start: f.start, end: f.end, segments: f.result })));
    const duration = Math.max(0, ...meeting.files.map((f) => f.end));
    const { text, speakers } = formatTranscript(merged, duration);
    if (hooks.apply(meeting, text, speakers)) {
      await idb.removeMeetingAudio(meeting.id);
      await idb.remove("meetings", meeting.id);
    }
    return { ok: true, meeting };
  } catch (err) {
    const attempts = (meeting.attempts || 0) + 1;
    const wait = api.isAccountProblem(err) ? BACKOFF_MAX_MS : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));
    diag.log("meeting failed", { id: meeting.id, code: err.code, err: err.message });
    Object.assign(meeting, {
      status: "failed",
      attempts,
      nextAt: Date.now() + wait,
      lastCode: err.code || "upstream",
      lastError: api.errorMessage({ ...err, provider: "mai" }),
    });
    await idb.put("meetings", meeting).catch(() => {});
    return { ok: false, meeting };
  }
}

export function startAuto() {
  setInterval(() => retry(), TICK_MS);
  window.addEventListener("online", () => retry({ wake: true }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") retry({ wake: true });
  });
  retry();
}
