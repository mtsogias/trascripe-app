// Audio helpers: stateful resampling to 16 kHz, WAV encoding, buffer concat.

export class Resampler {
  constructor(inRate, outRate = 16000) {
    this.ratio = inRate / outRate;
    // Decimation state (ratio > 1)
    this.sum = 0;
    this.n = 0;
    this.pos = 0;
    this.next = this.ratio;
    // Interpolation state (ratio < 1)
    this.last = 0;
    this.t = 1;
  }

  process(input) {
    if (this.ratio === 1) return input.slice();
    return this.ratio > 1 ? this._decimate(input) : this._interpolate(input);
  }

  // Box filter: average every `ratio` input samples.
  _decimate(input) {
    const out = [];
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.n++;
      this.pos++;
      if (this.pos >= this.next) {
        out.push(this.sum / this.n);
        this.sum = 0;
        this.n = 0;
        this.next += this.ratio;
      }
    }
    if (this.pos > 1e6 && this.next > 1e6) {
      this.pos -= 1e6;
      this.next -= 1e6;
    }
    return Float32Array.from(out);
  }

  // Linear interpolation. Combined index 0 is the previous sample, index k is input[k-1].
  _interpolate(input) {
    const out = [];
    let t = this.t;
    while (t < input.length) {
      const i = Math.floor(t);
      const a = i === 0 ? this.last : input[i - 1];
      const b = input[i];
      out.push(a + (b - a) * (t - i));
      t += this.ratio;
    }
    if (input.length) this.last = input[input.length - 1];
    this.t = t - input.length;
    return Float32Array.from(out);
  }
}

export function encodeWav(samples, sampleRate = 16000) {
  return new Blob([encodeWavBytes(samples, sampleRate)], { type: "audio/wav" });
}

export function encodeWavBytes(samples, sampleRate = 16000) {
  const dataSize = samples.length * 2;
  const view = new DataView(new ArrayBuffer(44 + dataSize));
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(view.buffer);
}

export function concatFloat32(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}
