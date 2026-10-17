// Collects mono mic samples into fixed-size blocks and posts them to the main thread.
const BLOCK_SIZE = 4096;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(BLOCK_SIZE);
    this.filled = 0;

    this.port.onmessage = (event) => {
      if (event.data?.type !== "flush") return;
      if (this.filled > 0) this.sendBlock(this.buffer.slice(0, this.filled));
      this.filled = 0;
      this.port.postMessage({ type: "flushed" });
    };
  }

  sendBlock(block) {
    this.port.postMessage(block, [block.buffer]);
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    let offset = 0;
    while (offset < input.length) {
      const count = Math.min(BLOCK_SIZE - this.filled, input.length - offset);
      this.buffer.set(input.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;

      if (this.filled === BLOCK_SIZE) {
        this.sendBlock(this.buffer);
        this.buffer = new Float32Array(BLOCK_SIZE);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
