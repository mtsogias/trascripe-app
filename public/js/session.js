// One recording (or dictation) session: captures segments, transcribes each
// one, and keeps the transcript in recording order.

import { Recorder } from "./recorder.js";
import { encodeWav } from "./audio-utils.js";
import { transcribeWav } from "./api.js";

const SAMPLE_RATE = 16000;

export class TranscriptionSession {
  constructor({ onText, onState, onError, lang = null } = {}) {
    this._cb = { onText, onState, onError };
    this.lang = lang;
    this._phase = "idle";
    this._recorder = null;
    this._cancelled = false;
    this._stopPromise = null;
    this._inflight = new Set();
    this._results = new Map(); // seq -> text ("" for empty or failed chunks)
    this._next = 0; // next seq to append
    this._parts = [];
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
    const blob = encodeWav(seg.samples, SAMPLE_RATE);
    const job = this._transcribe(seg.seq, blob).finally(() => {
      this._inflight.delete(job);
      this._emit();
    });
    this._inflight.add(job);
    this._emit();
  }

  async _transcribe(seq, blob) {
    let text = "";
    try {
      const result = await transcribeWav(blob, { lang: this.lang });
      text = result.text;
      if (text && result.language && !this.lang) this.lang = result.language;
    } catch (err) {
      if (!this._cancelled) this._notify("onError", err, "chunk");
    }
    this._results.set(seq, text);
    this._flush();
  }

  // Append results in seq order; a gap stops the flush until that seq arrives.
  _flush() {
    if (this._cancelled) return;
    let changed = false;
    while (this._results.has(this._next)) {
      const text = this._results.get(this._next);
      this._results.delete(this._next);
      this._next++;
      if (text) {
        this._parts.push(text);
        changed = true;
      }
    }
    if (changed) this._notify("onText", this.text);
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
