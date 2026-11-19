// Joins the transcripts of a meeting's files into one text with consistent speakers.
// Long meetings are recorded as several files that overlap by a minute; the provider numbers speakers per
// file, so speakers are matched by who talks at the same time in the overlap.

const MIN_MATCH_SEC = 1; // overlapping speech needed to treat two speaker labels as the same person

const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

// files: [{ start, end, segments: [{ start, end, speaker, text }] }] with start/end in seconds since the
// meeting began and segment times relative to their file. Returns segments in meeting time with
// speaker = global index (0, 1, …) or null.
export function mergeFiles(files) {
  const out = [];
  let nextSpeaker = 0;
  let prev = null; // { segments (meeting time, global speakers) }

  files.forEach((file, k) => {
    const abs = file.segments.map((s) => ({ ...s, start: s.start + file.start, end: s.end + file.start }));
    const map = new Map(); // local label -> global index

    if (prev) {
      // Score every (local, global) pair by simultaneous speech in the overlap.
      const overlapEnd = files[k - 1].end;
      const scores = [];
      const totals = new Map();
      for (const s of abs) {
        if (s.speaker === null || s.start >= overlapEnd) continue;
        for (const p of prev.segments) {
          if (p.speaker === null) continue;
          const o = overlap(s, p);
          if (!o) continue;
          const key = `${s.speaker}|${p.speaker}`;
          totals.set(key, (totals.get(key) ?? 0) + o);
        }
      }
      for (const [key, score] of totals) {
        const [local, global] = key.split("|").map(Number);
        scores.push({ local, global, score });
      }
      scores.sort((a, b) => b.score - a.score);
      const usedGlobal = new Set();
      for (const { local, global, score } of scores) {
        if (score < MIN_MATCH_SEC || map.has(local) || usedGlobal.has(global)) continue;
        map.set(local, global);
        usedGlobal.add(global);
      }
      // Someone who was silent in the overlap: if exactly one label is left on each side, it is most
      // likely the same person (people rarely join and leave at the same moment).
      const leftLocal = [...new Set(abs.map((s) => s.speaker))].filter((l) => l !== null && !map.has(l));
      const leftGlobal = [...new Set(prev.segments.map((s) => s.speaker))].filter((g) => g !== null && !usedGlobal.has(g));
      if (leftLocal.length === 1 && leftGlobal.length === 1) map.set(leftLocal[0], leftGlobal[0]);
    }

    const toGlobal = (label) => {
      if (label === null || label === undefined) return null;
      if (!map.has(label)) map.set(label, nextSpeaker++);
      return map.get(label);
    };
    // Assign new numbers in order of appearance.
    const mapped = abs
      .sort((a, b) => a.start - b.start)
      .map((s) => ({ ...s, speaker: toGlobal(s.speaker) }));

    // Each side of an overlap keeps the half nearer to its own middle (edges are least accurate).
    const low = k > 0 ? (file.start + files[k - 1].end) / 2 : -Infinity;
    const high = k < files.length - 1 ? (files[k + 1].start + file.end) / 2 : Infinity;
    out.push(...mapped.filter((s) => s.start >= low && s.start < high));
    prev = { segments: mapped };
  });

  return out.sort((a, b) => a.start - b.start);
}

export function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export const speakerName = (index) => `Sprecher ${index + 1}`;

// Builds the note text: a heading, then one paragraph per speaker turn.
export function formatTranscript(segments, durationSec) {
  const minutes = Math.max(1, Math.round(durationSec / 60));
  const turns = [];
  for (const s of segments) {
    const last = turns.at(-1);
    if (last && last.speaker === s.speaker) last.text.push(s.text);
    else turns.push({ speaker: s.speaker, start: s.start, text: [s.text] });
  }
  const speakers = [];
  const lines = turns.map((t) => {
    const who = t.speaker === null ? "" : `${speakerName(t.speaker)}: `;
    if (t.speaker !== null && !speakers.includes(speakerName(t.speaker))) speakers.push(speakerName(t.speaker));
    return `[${formatTime(t.start)}] ${who}${t.text.join(" ")}`;
  });
  const body = lines.length ? lines.join("\n\n") : "(Nichts erkannt)";
  return { text: `Meeting · ${minutes} Min.\n\n${body}`, speakers };
}
