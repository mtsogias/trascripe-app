// Client for the server functions in api/. Errors carry `.status` and `.code`
// (credits | key | config | rate | bad | upstream | network | timeout).
import * as diag from "./diag.js";
import * as settings from "./settings.js";

const TIMEOUT_MS = 60000;
const RETRY_DELAYS_MS = [800, 2000];
const BLOCK_MS = 30 * 60000; // a provider with a credits/key problem is skipped this long

// Problems that will not go away by retrying soon.
export const isAccountProblem = (err) => ["credits", "key", "config"].includes(err?.code);

const blocked = new Map(); // provider -> { until, code }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apiError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

// One request with a timeout; parses JSON and turns error responses into apiError.
export async function request(url, { method = "POST", headers, body, timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
      throw apiError(msg, res.status, data?.code || (res.status >= 500 ? "upstream" : "bad"));
    }
    return data;
  } catch (err) {
    if (err.status) throw err;
    if (err.name === "AbortError") throw apiError("Zeitüberschreitung", 0, "timeout");
    throw apiError("Netzwerkfehler", 0, "network");
  } finally {
    clearTimeout(timer);
  }
}

const retryable = (err) => ["network", "timeout", "rate", "upstream"].includes(err.code);

async function transcribeOnce(blob, provider, lang) {
  let url = `/api/transcribe?provider=${provider}`;
  if (lang && /^[a-z]{2}$/i.test(lang)) url += `&lang=${lang.toLowerCase()}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await request(url, { headers: { "Content-Type": "audio/wav" }, body: blob });
      return {
        text: (data?.text || "").trim(),
        language: data?.language || null,
        dropped: data?.dropped ?? 0,
        provider,
      };
    } catch (err) {
      if (!retryable(err) || attempt >= RETRY_DELAYS_MS.length) throw err;
      diag.log("retry", { provider, attempt: attempt + 1, code: err.code, err: err.message });
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

export function isBlocked(provider) {
  const b = blocked.get(provider);
  if (b && b.until > Date.now()) return b;
  blocked.delete(provider);
  return null;
}

// Providers to try, in order. `force` (manual retry) ignores blocks.
export function providerOrder({ force = false } = {}) {
  const { provider, fallback } = settings.get();
  const order = [provider];
  if (fallback) order.push(provider === "groq" ? "mai" : "groq");
  return force ? order : order.filter((p) => !isBlocked(p));
}

// Transcribes a WAV chunk with the chosen provider, then the fallback. Throws the first provider's
// error when all fail; err.allBlocked tells whether every provider has an account problem.
export async function transcribeWav(blob, { lang, force = false } = {}) {
  const order = providerOrder({ force });
  if (!order.length) {
    const first = settings.get().provider;
    throw Object.assign(apiError("Anbieter gesperrt", 0, isBlocked(first)?.code || "credits"), {
      provider: first,
      allBlocked: true,
    });
  }
  let firstErr = null;
  for (const provider of order) {
    try {
      const result = await transcribeOnce(blob, provider, lang);
      blocked.delete(provider);
      return result;
    } catch (err) {
      err.provider = provider;
      diag.log("provider failed", { provider, code: err.code, status: err.status, err: err.message });
      if (isAccountProblem(err)) blocked.set(provider, { until: Date.now() + BLOCK_MS, code: err.code });
      firstErr ??= err;
      if (err.code === "bad") break; // the audio itself was rejected; another provider will not help
    }
  }
  firstErr.allBlocked = providerOrder().length === 0;
  throw firstErr;
}

export function summarize(text, model) {
  return request("/api/summarize", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, model }),
    timeoutMs: 120000,
  });
}

export function listModels() {
  return request("/api/summarize?models", { method: "GET", timeoutMs: 20000 });
}

export function meetingUpload(id, file, part, bytes) {
  return request(`/api/meeting?action=upload&id=${id}&file=${file}&part=${part}`, {
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
    timeoutMs: 120000,
  });
}

export function meetingTranscribe(id, file, parts, lang) {
  let url = `/api/meeting?action=transcribe&id=${id}&file=${file}&parts=${parts}`;
  if (lang) url += `&lang=${lang}`;
  return request(url, { timeoutMs: 300000 });
}

export function meetingDiscard(id) {
  return request(`/api/meeting?action=discard&id=${id}`, { timeoutMs: 30000 }).catch(() => {});
}

// Human-readable reason for an error, for toasts and banners.
export function errorMessage(err) {
  const name = err?.provider === "mai" || err?.provider === "openrouter" ? "OpenRouter" : "Groq";
  switch (err?.code) {
    case "credits": return `Guthaben bei ${name} aufgebraucht`;
    case "key": return `API-Schlüssel für ${name} ungültig`;
    case "config": return `API-Schlüssel für ${name} fehlt auf dem Server`;
    case "rate": return `${name}: zu viele Anfragen`;
    case "network": return "Keine Internetverbindung";
    case "timeout": return "Server antwortet nicht";
    default: return err?.message || "Unbekannter Fehler";
  }
}
