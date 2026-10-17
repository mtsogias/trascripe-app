import { Segmenter, SAMPLE_RATE } from "./vad.js";
import { Resampler } from "./audio-utils.js";

const WORKLET_URL = "/js/pcm-worklet.js";
const SCRIPT_BLOCK_SIZE = 4096;
const FLUSH_TIMEOUT_MS = 300;

function recorderError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export class Recorder {
  constructor({ onSegment, onError } = {}) {
    this.onSegment = onSegment;
    this.onError = onError;
    this._seq = 0;
    this._running = false;
    this._stopPromise = null;
    this._analyser = null;
    this._stream = null;
    this._ctx = null;
    this._source = null;
    this._capture = null;
    this._mute = null;
    this._resampler = null;
    this._segmenter = null;
    this._onFlushed = null;
  }

  get analyser() {
    return this._analyser;
  }

  get isRecording() {
    return this._running;
  }

  async start() {
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) throw recorderError("Recording is not supported", "unsupported");

    let stream;
    try {
      stream = await media.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      if (err.name === "NotAllowedError" || err.name === "SecurityError") {
        throw recorderError(err.message, "mic-denied");
      }
      if (err.name === "NotFoundError") throw recorderError(err.message, "no-mic");
      throw err;
    }

    this._stream = stream;
    try {
      await this._buildGraph(stream);
      if (this._stopPromise) throw recorderError("Recording stopped during start", "cancelled");
    } catch (err) {
      await this._teardown();
      throw err;
    }
    this._running = true;
  }

  stop() {
    this._stopPromise ??= this._finish();
    return this._stopPromise;
  }

  async _buildGraph(stream) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    this._ctx = ctx;
    await ctx.resume();

    this._resampler = new Resampler(ctx.sampleRate, SAMPLE_RATE);
    this._segmenter = new Segmenter();
    this._capture = await this._createCapture(ctx);
    this._source = ctx.createMediaStreamSource(stream);
    this._mute = ctx.createGain();
    this._mute.gain.value = 0;
    this._analyser = ctx.createAnalyser();
    this._analyser.fftSize = 256;
    this._analyser.smoothingTimeConstant = 0.45;

    this._source.connect(this._capture);
    this._capture.connect(this._mute);
    this._mute.connect(ctx.destination);
    this._source.connect(this._analyser);

    stream.getAudioTracks()[0].onended = () => {
      if (this._running) this._report(new Error("mic-ended"));
    };
    ctx.onstatechange = () => {
      if (this._running && (ctx.state === "suspended" || ctx.state === "interrupted")) {
        ctx.resume().catch(() => this._report(new Error("mic-interrupted")));
      }
    };
  }

  async _createCapture(ctx) {
    if (ctx.audioWorklet) {
      try {
        await ctx.audioWorklet.addModule(WORKLET_URL);
        const node = new AudioWorkletNode(ctx, "pcm-capture", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        node.port.onmessage = (event) => this._onMessage(event.data);
        return node;
      } catch (err) {
        console.warn("AudioWorklet unavailable, falling back to ScriptProcessor", err);
      }
    }

    const node = ctx.createScriptProcessor(SCRIPT_BLOCK_SIZE, 1, 1);
    node.onaudioprocess = (event) => this._onPcm(event.inputBuffer.getChannelData(0));
    return node;
  }

  _onMessage(data) {
    if (data instanceof Float32Array) this._onPcm(data);
    else if (data?.type === "flushed") this._onFlushed?.();
  }

  _onPcm(samples) {
    if (!this._segmenter) return;
    this._emit(this._segmenter.push(this._resampler.process(samples)));
  }

  _emit(segments) {
    for (const seg of segments) {
      try {
        this.onSegment?.({ ...seg, seq: this._seq++ });
      } catch (err) {
        console.error("onSegment failed", err);
      }
    }
  }

  _report(err) {
    try {
      this.onError?.(err);
    } catch (handlerErr) {
      console.error("onError failed", handlerErr);
    }
  }

  // Ask the worklet to post its remaining samples; the timeout keeps stop() from hanging.
  _flushWorklet(node) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this._onFlushed = null;
        resolve();
      };
      const timer = setTimeout(done, FLUSH_TIMEOUT_MS);
      this._onFlushed = done;
      node.port.postMessage({ type: "flush" });
    });
  }

  async _finish() {
    this._running = false;
    if (this._capture?.port) await this._flushWorklet(this._capture);
    await this._teardown();
    const last = this._segmenter?.flush() ?? [];
    this._segmenter = null;
    this._analyser = null;
    this._emit(last);
  }

  async _teardown() {
    for (const node of [this._source, this._capture, this._mute]) node?.disconnect();
    this._stream?.getTracks().forEach((track) => track.stop());
    await this._ctx?.close().catch(() => {});
    this._ctx = null;
    this._stream = null;
    this._analyser = null;
  }
}
