// Bar-style level meter drawn on a canvas, fed by an AnalyserNode.

const SMOOTHING = 0.42;
const GAP = 4;       // css px between bars
const MIN_BAR = 6;   // css px minimum bar height

export function createWaveform(canvas, { bars = 15, gain = 2 } = {}) {
  const ctx = canvas.getContext("2d");
  const levels = new Float32Array(bars);
  let analyser = null;
  let buffer = null;
  let color = "";
  let dpr = 1;
  let raf = 0;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  }

  function readLevels() {
    analyser.getByteTimeDomainData(buffer);
    const slice = Math.floor(buffer.length / bars);
    for (let i = 0; i < bars; i++) {
      let peak = 0;
      for (let j = i * slice; j < (i + 1) * slice; j++) {
        peak = Math.max(peak, Math.abs(buffer[j] - 128) / 128);
      }
      const boosted = Math.min(1, peak * gain);
      levels[i] += (boosted - levels[i]) * SMOOTHING;
    }
  }

  function paint() {
    const w = canvas.width;
    const h = canvas.height;
    const gap = GAP * dpr;
    const minH = MIN_BAR * dpr;
    const barW = Math.max(3 * dpr, (w - gap * (bars - 1)) / bars);
    // Round caps add barW/2 at each end, so the painted extent at full level is exactly h.
    const maxH = h - barW;
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = "round";
    ctx.lineWidth = barW;
    ctx.strokeStyle = color;
    for (let i = 0; i < bars; i++) {
      const barH = minH + levels[i] * (maxH - minH);
      const x = i * (barW + gap) + barW / 2;
      const y = (h - barH) / 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + barH);
      ctx.stroke();
    }
  }

  function tick() {
    readLevels();
    paint();
    raf = requestAnimationFrame(tick);
  }

  function cancel() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  return {
    start(node) {
      cancel();
      analyser = node || null;
      color = getComputedStyle(canvas).color;
      resize();
      levels.fill(0);
      if (!analyser) {
        paint();
        return;
      }
      buffer = new Uint8Array(analyser.fftSize);
      tick();
    },
    stop() {
      cancel();
      analyser = null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}
