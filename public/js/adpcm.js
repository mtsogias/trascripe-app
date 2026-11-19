// IMA ADPCM encoder (WAV format 0x11, mono). 4 bits per sample: 16 kHz speech needs ~8 KB/s,
// a quarter of 16-bit PCM. Blocks are self-contained, so any run of blocks plus a header is a valid file.

const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88,
  97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658,
  724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660,
  4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818,
  18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX_ADJUST = [-1, -1, -1, -1, 2, 4, 6, 8];

export const BLOCK_ALIGN = 512;
export const SAMPLES_PER_BLOCK = (BLOCK_ALIGN - 4) * 2 + 1; // 1017

const clamp16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

export class AdpcmEncoder {
  constructor() {
    this._pending = new Int16Array(SAMPLES_PER_BLOCK);
    this._filled = 0;
    this._index = 0; // step index carries over between blocks for a smooth start
    this.samples = 0; // real samples encoded so far (without padding)
  }

  // Float samples in [-1, 1]; returns complete blocks (Uint8Array, a multiple of BLOCK_ALIGN bytes).
  push(floats) {
    const out = [];
    for (let i = 0; i < floats.length; i++) {
      const s = Math.max(-1, Math.min(1, floats[i]));
      this._pending[this._filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._filled === SAMPLES_PER_BLOCK) {
        out.push(this._encodeBlock(this._pending));
        this._filled = 0;
      }
    }
    this.samples += floats.length;
    return joinBlocks(out);
  }

  // Pads the last partial block with silence. Call once at the end.
  flush() {
    if (!this._filled) return new Uint8Array(0);
    this._pending.fill(0, this._filled);
    this._filled = 0;
    return this._encodeBlock(this._pending);
  }

  _encodeBlock(pcm) {
    const block = new Uint8Array(BLOCK_ALIGN);
    let predictor = pcm[0];
    let index = this._index;
    block[0] = predictor & 0xff;
    block[1] = (predictor >> 8) & 0xff;
    block[2] = index;
    block[3] = 0;

    let byte = 4;
    for (let i = 1; i < SAMPLES_PER_BLOCK; i++) {
      const step = STEPS[index];
      let diff = pcm[i] - predictor;
      let nibble = 0;
      if (diff < 0) {
        nibble = 8;
        diff = -diff;
      }
      // Quantise and reconstruct exactly like the decoder does.
      let delta = step >> 3;
      if (diff >= step) { nibble |= 4; diff -= step; delta += step; }
      if (diff >= step >> 1) { nibble |= 2; diff -= step >> 1; delta += step >> 1; }
      if (diff >= step >> 2) { nibble |= 1; delta += step >> 2; }
      predictor = clamp16(nibble & 8 ? predictor - delta : predictor + delta);
      index = Math.max(0, Math.min(88, index + INDEX_ADJUST[nibble & 7]));

      // Samples 1..n pair up: low nibble first.
      if (i % 2 === 1) block[byte] = nibble;
      else block[byte++] |= nibble << 4;
    }
    this._index = index;
    return block;
  }
}

function joinBlocks(blocks) {
  if (blocks.length === 1) return blocks[0];
  const out = new Uint8Array(blocks.length * BLOCK_ALIGN);
  blocks.forEach((b, i) => out.set(b, i * BLOCK_ALIGN));
  return out;
}

// WAV header for `blocks` blocks holding `samples` real samples.
export function adpcmWavHeader(blocks, samples, sampleRate = 16000) {
  const dataSize = blocks * BLOCK_ALIGN;
  const view = new DataView(new ArrayBuffer(60));
  const str = (off, s) => [...s].forEach((c, i) => view.setUint8(off + i, c.charCodeAt(0)));
  str(0, "RIFF");
  view.setUint32(4, 52 + dataSize, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 20, true);
  view.setUint16(20, 0x11, true); // IMA ADPCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, Math.round((sampleRate * BLOCK_ALIGN) / SAMPLES_PER_BLOCK), true);
  view.setUint16(32, BLOCK_ALIGN, true);
  view.setUint16(34, 4, true); // bits per sample
  view.setUint16(36, 2, true); // extra size
  view.setUint16(38, SAMPLES_PER_BLOCK, true);
  str(40, "fact");
  view.setUint32(44, 4, true);
  view.setUint32(48, Math.min(samples, blocks * SAMPLES_PER_BLOCK), true);
  str(52, "data");
  view.setUint32(56, dataSize, true);
  return new Uint8Array(view.buffer);
}
