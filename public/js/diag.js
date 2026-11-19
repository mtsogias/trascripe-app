// Recording diagnostics: a small rolling text log kept in localStorage so it
// survives a crash or reload. Copied from the sidebar ("Protokoll kopieren").

const KEY = "whisperflow.diag.v1";
const MAX_RECORDINGS = 10; // keep the last 10 recordings
const MAX_CHARS = 300000; // and never more than ~300 KB in total
const START = "===== ";
const START_RE = /===== \w+ start/;
const SAVE_DELAY_MS = 2000;

let lines = null;
let saveTimer = null;
let t0 = 0;

function load() {
  if (lines) return lines;
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY));
    lines = Array.isArray(parsed) ? parsed : [];
  } catch {
    lines = [];
  }
  return lines;
}

// Drops whole old recordings beyond MAX_RECORDINGS, then the oldest lines
// until the log fits MAX_CHARS.
function trim() {
  let starts = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (START_RE.test(lines[i]) && ++starts === MAX_RECORDINGS) {
      lines.splice(0, i); // everything before the oldest recording we keep
      break;
    }
  }
  let total = 0;
  for (const line of lines) total += line.length + 3;
  let drop = 0;
  while (total > MAX_CHARS && drop < lines.length) total -= lines[drop++].length + 3;
  if (drop) lines.splice(0, drop);
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  trim();
  try {
    localStorage.setItem(KEY, JSON.stringify(lines));
  } catch {
    // Quota: drop the older half and try once more.
    lines.splice(0, Math.floor(lines.length / 2));
    try {
      localStorage.setItem(KEY, JSON.stringify(lines));
    } catch {}
  }
}

function clock() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function elapsed() {
  if (!t0) return "";
  const s = Math.floor((Date.now() - t0) / 1000);
  return ` +${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function log(event, data) {
  const buf = load();
  let line = `${clock()}${elapsed()} ${event}`;
  if (data !== undefined) {
    try {
      line += " " + JSON.stringify(data);
    } catch {}
  }
  buf.push(line);
  saveTimer ??= setTimeout(save, SAVE_DELAY_MS);
}

// Marks the start of a recording; later lines show time since this point.
export function begin(kind) {
  t0 = Date.now();
  log(`${START}${kind} start`, {
    date: new Date().toISOString(),
    ua: navigator.userAgent,
    standalone: matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true,
  });
}

export function end(reason) {
  log(`${START}end`, { reason });
  t0 = 0;
  save();
}

export function flush() {
  if (saveTimer) save();
}

export function text() {
  return load().join("\n");
}

export function clear() {
  lines = [];
  save();
}
