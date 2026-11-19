// Chunks of normal recordings and dictations that are not transcribed yet. Each chunk is saved in
// IndexedDB before it is sent and removed once its text is in the note. Failed chunks are retried in the
// background with backoff; the note shows a marker at their place until then.
//
// Record: { id, noteId, marker, lang, wav: Uint8Array, status: "sending" | "failed",
//           createdAt, attempts, nextAt, lastCode }
import * as idb from "./idb.js";
import * as diag from "./diag.js";
import { transcribeWav, isAccountProblem } from "./api.js";

const STORE = "chunks";
const TICK_MS = 30000;
const BACKOFF_BASE_MS = 30000;
const BACKOFF_MAX_MS = 15 * 60000;

const active = new Set(); // ids a running session is still handling
let hooks = { apply: () => true, skipNote: () => false, onChange: () => {}, onAccountProblem: () => {} };
let running = null;
let again = false;

export function configure(h) {
  hooks = { ...hooks, ...h };
}

export async function save(rec) {
  active.add(rec.id);
  try {
    await idb.put(STORE, { status: "sending", attempts: 0, nextAt: 0, createdAt: Date.now(), ...rec });
    return true;
  } catch (err) {
    diag.log("pending save failed", { err: String(err) });
    return false;
  }
}

// The session is done with this chunk: sent (remove) or failed (keep for retry).
export async function settle(id, err) {
  active.delete(id);
  try {
    if (!err) {
      await idb.remove(STORE, id);
    } else {
      const rec = await idb.getOne(STORE, id);
      if (rec) await idb.put(STORE, { ...rec, status: "failed", ...backoff(rec, err) });
    }
  } catch (e) {
    diag.log("pending settle failed", { err: String(e) });
  }
  hooks.onChange();
}

function backoff(rec, err) {
  const attempts = (rec.attempts || 0) + 1;
  // Account problems wait for the full block; other errors back off exponentially.
  const wait = isAccountProblem(err) ? BACKOFF_MAX_MS : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));
  return { attempts, nextAt: Date.now() + wait, lastCode: err?.code || "upstream" };
}

async function all() {
  try {
    return await idb.getAll(STORE);
  } catch {
    return [];
  }
}

// Open chunks per note id (excluding ones a running session still handles).
export async function countByNote() {
  const counts = new Map();
  for (const rec of await all()) {
    if (active.has(rec.id)) continue;
    counts.set(rec.noteId, (counts.get(rec.noteId) ?? 0) + 1);
  }
  return counts;
}

export async function forget(noteId) {
  for (const rec of await all()) {
    if (rec.noteId === noteId && !active.has(rec.id)) await idb.remove(STORE, rec.id).catch(() => {});
  }
  hooks.onChange();
}

// Sends due chunks. force: ignore backoff and blocked providers (manual "Erneut senden").
// wake: the connection or app just came back, so chunks that failed for lack of network are due now.
export function retry({ force = false, wake = false, noteId = null } = {}) {
  if (running) {
    again ||= force;
    return running;
  }
  running = process(force, wake, noteId).finally(() => {
    running = null;
    if (again) {
      again = false;
      retry({ force: true });
    }
  });
  return running;
}

const OFFLINE_CODES = ["network", "timeout"];

async function process(force, wake, noteId) {
  const now = Date.now();
  const isDue = (r) => force || r.nextAt <= now || (wake && OFFLINE_CODES.includes(r.lastCode));
  const due = (await all())
    .filter((r) => !active.has(r.id) && (!noteId || r.noteId === noteId) && isDue(r))
    .sort((a, b) => a.createdAt - b.createdAt);
  let sent = 0;
  let failed = 0;
  let accountErr = null;
  for (const rec of due) {
    if (hooks.skipNote(rec.noteId)) continue; // being recorded or dictated into right now
    try {
      const result = await transcribeWav(new Blob([rec.wav], { type: "audio/wav" }), { lang: rec.lang, force });
      if (hooks.apply(rec, result.text)) {
        await idb.remove(STORE, rec.id);
        sent++;
      }
      diag.log("pending sent", { id: rec.id, chars: result.text.length, provider: result.provider });
    } catch (err) {
      failed++;
      diag.log("pending failed", { id: rec.id, code: err.code, err: err.message });
      await idb.put(STORE, { ...rec, status: "failed", ...backoff(rec, err) }).catch(() => {});
      if (err.allBlocked || isAccountProblem(err)) accountErr ??= err;
      // Offline or all providers blocked: the rest would fail the same way.
      if (err.code === "network" || err.allBlocked) break;
    }
  }
  if (accountErr && force) hooks.onAccountProblem(accountErr);
  if (due.length) hooks.onChange();
  return { sent, failed, total: due.length };
}

export function startAuto() {
  setInterval(() => retry(), TICK_MS);
  window.addEventListener("online", () => retry({ wake: true }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") retry({ wake: true });
  });
  retry();
}
