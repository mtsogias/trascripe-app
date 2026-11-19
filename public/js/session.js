// One recording (or dictation) session: captures segments, transcribes each one, and keeps the
// transcript in recording order. Every segment is saved on the device first (pending.js); a segment that
// cannot be sent leaves a marker in the text and is retried later.

import { Recorder } from "./recorder.js";
import { encodeWavBytes } from "./audio-utils.js";
import { transcribeWav } from "./api.js";
import * as pending from "./pending.js";
import * as diag from "./diag.js";

const SAMPLE_RATE = 16000;

const clock = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function markerFor(startMs, durationMs) {
  return `[⏳ ${clock(startMs)}–${clock(startMs + durationMs)} wird nachgereicht]`;
}

export class TranscriptionSession {
  constructor({ onText, onState, onError, lang = null, noteId } = {}) {
    this._cb = { onText, onState, onError };
    this.lang = lang;
    this.noteId = noteId;
    this.id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this._phase = "idle";
    this._recorder = null;
    this._cancelled = false;
    this._stopPromise = null;
    this._inflight = new Set();
    this._results = new Map(); // seq -> text ("" for empty chunks, a marker for failed ones)
    this._sent = new Map(); // seq -> pending id, removed once its text is in the note
    this._next = 0; // next seq to append
    this._parts = [];
    this.failed = 0;
  }

  get analyser() {
    return this._recorder?.analyser ?? null;
  }

  get phase() {
    return this._phase;
  }

  get text() {
    return this._parts.join(" ");
  }

  async start() {
    this._recorder = new Recorder({
      onSegment: (seg) => this._handleSegment(seg),
      onError: (err) => {
        diag.log("fatal", { err: err?.message });
        if (!this._cancelled) this._notify("onError", err, "fatal");
      },
    });
    try {
      await this._recorder.start();
    } catch (err) {
      this._recorder = null;
      // A stop() that arrived mid-start already ended the session ("done").
      if (!this._stopPromise) this._setPhase("idle");
      throw err;
    }
    this._setPhase("recording");
  }

  stop() {
    if (!this._stopPromise) this._stopPromise = this._stop();
    return this._stopPromise;
  }

  cancel() {
    if (this._cancelled) return;
    this._cancelled = true;
    this._recorder?.stop().catch(() => {});
    this._inflight.clear();
    this._setPhase("done");
  }

  async _stop() {
    this._setPhase("finishing");
    try {
      // May synchronously deliver the last segment via _handleSegment.
      await this._recorder?.stop();
    } catch (err) {
      console.error(err);
    }
    while (this._inflight.size) {
      await Promise.allSettled([...this._inflight]);
    }
    this._setPhase("done");
    return this.text.trim();
  }

  _handleSegment(seg) {
    if (this._cancelled) return;
    const job = this._transcribe(seg).finally(() => {
      this._inflight.delete(job);
      this._emit();
    });
    this._inflight.add(job);
    this._emit();
  }

  async _transcribe(seg) {
    const id = `${this.id}-${seg.seq}`;
    const wav = encodeWavBytes(seg.samples, SAMPLE_RATE);
    const marker = markerFor(seg.startMs ?? 0, seg.durationMs ?? 0);
    // Saved before sending, so the audio survives a crash or a failed request.
    await pending.save({ id, noteId: this.noteId, marker, lang: this.lang, wav });

    let text = "";
    const t = Date.now();
    try {
      const result = await transcribeWav(new Blob([wav], { type: "audio/wav" }), { lang: this.lang });
      text = result.text;
      diag.log("sent", { seq: seg.seq, ms: Date.now() - t, chars: text.length, provider: result.provider, dropped: result.dropped });
      if (text && result.language && !this.lang) this.lang = result.language;
      this._sent.set(seg.seq, id);
    } catch (err) {
      diag.log("send failed", { seq: seg.seq, ms: Date.now() - t, code: err.code, err: err.message });
      text = marker;
      this.failed++;
      await pending.settle(id, err);
      if (!this._cancelled) this._notify("onError", err, "chunk");
    }
    this._results.set(seg.seq, text);
    this._flush();
  }

  // Append results in seq order; a gap stops the flush until that seq arrives. The app saves the text
  // in onText, so the saved audio of the flushed chunks can go afterwards.
  _flush() {
    if (this._cancelled) return;
    let changed = false;
    const flushed = [];
    while (this._results.has(this._next)) {
      const text = this._results.get(this._next);
      this._results.delete(this._next);
      if (this._sent.has(this._next)) flushed.push(this._sent.get(this._next));
      this._sent.delete(this._next);
      this._next++;
      if (text) {
        this._parts.push(text);
        changed = true;
      }
    }
    if (changed) this._notify("onText", this.text);
    for (const id of flushed) pending.settle(id);
  }

  _setPhase(phase) {
    if (this._phase === phase || (this._cancelled && phase !== "done")) return;
    this._phase = phase;
    this._emit();
  }

  _emit() {
    this._notify("onState", { phase: this._phase, pending: this._inflight.size });
  }

  _notify(name, ...args) {
    try {
      this._cb[name]?.(...args);
    } catch (err) {
      console.error(err);
    }
  }
}
