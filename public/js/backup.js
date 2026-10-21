// Automatic backup of all notes and folders to the server (api/backup.js).
// The phone stays the main copy; the server only keeps the latest backup (plus one per day).
import * as store from "./store.js";

const ENDPOINT = "/api/backup";
const PASSWORD_KEY = "whisperflow.backupPassword.v1";
const LAST_KEY = "whisperflow.lastBackup.v1";
const DELAY_MS = 5000;
const RETRY_MS = 60000;
const KEEPALIVE_MAX = 60000; // browsers cap keepalive bodies at 64 KB

let timer = null;
let running = null;
let dirty = false;
let failed = false;
let listener = () => {};

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

async function request(method, password, body) {
  const res = await fetch(ENDPOINT, {
    method,
    headers: {
      Authorization: `Bearer ${password}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body,
    keepalive: !!body && body.length < KEEPALIVE_MAX,
  });
  if (res.status === 401) throw Object.assign(new Error("Falsches Passwort"), { code: "auth" });
  if (method === "GET" && res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Calls fn(event) when the status changes; event is "auth" when the password stopped working.
export function onStatus(fn) {
  listener = fn;
}

export function status() {
  return { setUp: !!read(PASSWORD_KEY), lastAt: read(LAST_KEY), failed };
}

// Latest backup on the server, or null if there is none. Throws { code: "auth" } on a wrong password.
export function fetchBackup(password = read(PASSWORD_KEY)) {
  return request("GET", password);
}

// Starts automatic backups with this password and uploads right away.
export function enable(password) {
  write(PASSWORD_KEY, password);
  failed = false;
  schedule(0);
}

export function schedule(delay = DELAY_MS) {
  if (!read(PASSWORD_KEY)) return;
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(flush, delay);
}

// Uploads now if anything changed since the last backup.
export function flush() {
  clearTimeout(timer);
  timer = null;
  const password = read(PASSWORD_KEY);
  if (!dirty || !password) return Promise.resolve();
  if (running) return running.then(flush);
  dirty = false;
  running = upload(password).finally(() => {
    running = null;
  });
  return running;
}

async function upload(password) {
  let event = null;
  try {
    await request("PUT", password, JSON.stringify(store.exportAll()));
    failed = false;
    write(LAST_KEY, new Date().toISOString());
  } catch (err) {
    dirty = true;
    failed = true;
    if (err.code === "auth") {
      write(PASSWORD_KEY, null); // stop until it is set up again
      event = "auth";
    } else {
      timer = setTimeout(flush, RETRY_MS);
    }
  }
  listener(event);
}
