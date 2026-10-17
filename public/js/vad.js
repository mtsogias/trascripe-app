// Client-side voice activity detection and chunking. Silent audio never leaves the device.
import { concatFloat32 } from "./audio-utils.js";

export const SAMPLE_RATE = 16000;
export const FRAME_SIZE = 320; // 20 ms
const FRAME_MS = 20;
const MIN_FLOOR = 1e-4;
const UTTERANCE_MIN_MS = 3000;

export const DEFAULTS = {
  absThreshold: 0.008, // RMS; ~ -42 dBFS
  floorRatio: 3.0, // speech if rms > max(absThreshold, noiseFloor * floorRatio)
  minSpeechMs: 300, // segments with less detected speech are discarded (never sent)
  prerollMs: 400, // audio kept before speech onset
  minChunkMs: 10000, // soft minimum before cutting at a short pause
  maxChunkMs: 28000, // hard cut
  pauseCutMs: 500, // pause that cuts once chunk >= minChunkMs
  utteranceEndMs: 1200, // pause that cuts once chunk >= 3000 ms
  silenceCutMs: 3000, // pause that always cuts
  tailKeepMs: 300, // trailing silence kept on a cut
};

export function rms(frame) {
  if (!frame.length) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

export class Segmenter {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this._level = 0;
    this._floor = null;
    this._carry = new Float32Array(0);
    this._reset();
  }

  get level() {
    return this._level;
  }

  // Returns completed, already gated segments.
  push(samples) {
    const buf = this._carry.length ? concatFloat32([this._carry, samples]) : samples;
    const out = [];
    let off = 0;
    for (; off + FRAME_SIZE <= buf.length; off += FRAME_SIZE) {
      const seg = this._processFrame(buf.subarray(off, off + FRAME_SIZE));
      if (seg) out.push(seg);
    }
    this._carry = buf.slice(off);
    return out;
  }

  // Emits the open segment (if it has speech) and resets. Call on stop.
  flush() {
    this._carry = new Float32Array(0);
    const seg = this._speechFrames > 0 ? this._cut() : null;
    this._reset();
    return seg ? [seg] : [];
  }

  _reset() {
    this._frames = [];
    this._speechFrames = 0;
    this._silenceRunMs = 0;
  }

  _processFrame(frame) {
    const o = this.opts;
    const r = rms(frame);
    this._level = r;

    if (this._floor === null) this._floor = Math.max(r, MIN_FLOOR);
    const floor = this._floor;
    const threshold = Math.max(o.absThreshold, floor * o.floorRatio);
    const isSpeech = r > threshold;

    if (r < floor) this._floor = floor * 0.9 + r * 0.1;
    else if (!isSpeech) this._floor = floor * 0.98 + r * 0.02;
    else this._floor = floor * 0.9995 + r * 0.0005;
    this._floor = Math.max(this._floor, MIN_FLOOR);

    this._frames.push(frame.slice());
    if (isSpeech) {
      this._speechFrames++;
      this._silenceRunMs = 0;
    }

    if (this._speechFrames === 0) {
      // No speech yet: keep only the preroll so long silence costs no memory.
      const maxPreroll = Math.floor(o.prerollMs / FRAME_MS);
      if (this._frames.length > maxPreroll) {
        this._frames.splice(0, this._frames.length - maxPreroll);
      }
      return null;
    }

    if (!isSpeech) this._silenceRunMs += FRAME_MS;
    return this._shouldCut() ? this._cut() : null;
  }

  _shouldCut() {
    const o = this.opts;
    const dur = this._frames.length * FRAME_MS;
    const silence = this._silenceRunMs;
    return (
      dur >= o.maxChunkMs ||
      (dur >= o.minChunkMs && silence >= o.pauseCutMs) ||
      (dur >= UTTERANCE_MIN_MS && silence >= o.utteranceEndMs) ||
      silence >= o.silenceCutMs
    );
  }

  _cut() {
    const o = this.opts;
    const dropFrames = Math.max(0, Math.floor((this._silenceRunMs - o.tailKeepMs) / FRAME_MS));
    const frames = this._frames.slice(0, this._frames.length - dropFrames);
    const speechMs = this._speechFrames * FRAME_MS;
    const seg =
      speechMs >= o.minSpeechMs
        ? {
            samples: concatFloat32(frames),
            speechMs,
            durationMs: frames.length * FRAME_MS,
          }
        : null;
    this._reset();
    return seg;
  }
}
