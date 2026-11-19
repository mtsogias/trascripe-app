// Speech-to-text providers behind one interface, plus shared request helpers.
// Errors carry `status` (HTTP status for our response) and `code`, which the app uses for messages:
// credits (balance or key limit used up), key (key missing or rejected), rate (too many requests),
// config (server not set up), bad (audio rejected), upstream (anything else).

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1";
export const MAI_MODEL = "microsoft/mai-transcribe-2";

export class ProviderError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Maps an upstream error response to our status and code.
function classify(provider, status, text) {
  const msg = String(text || "").slice(0, 300);
  if (status === 402 || /credit|insufficient|balance|key limit|limit exceeded|quota/i.test(msg)) {
    return new ProviderError(`${provider}: ${msg}`, 402, "credits");
  }
  if (status === 401 || status === 403) return new ProviderError(`${provider}: ${msg}`, 401, "key");
  if (status === 429) return new ProviderError(`${provider}: ${msg}`, 429, "rate");
  if (status === 400 || status === 413 || status === 415) return new ProviderError(`${provider}: ${msg}`, 400, "bad");
  return new ProviderError(`${provider}: ${msg}`, 502, "upstream");
}

async function fetchWithTimeout(url, options, timeoutMs, provider) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw classify(provider, res.status, await res.text().catch(() => ""));
    return await res.json();
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err.name === "AbortError") throw new ProviderError(`${provider}: timeout`, 504, "upstream");
    throw new ProviderError(`${provider}: ${err.message}`, 502, "upstream");
  } finally {
    clearTimeout(timer);
  }
}

function openRouterKey() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new ProviderError("OPENROUTER_API_KEY not set on server", 500, "config");
  return key;
}

// Whisper via Groq. Returns Groq's verbose_json (segments with no_speech_prob etc.).
export async function groqTranscribe(buf, { lang, timeoutMs = 55000 } = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new ProviderError("GROQ_API_KEY not set on server", 500, "config");
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/wav" }), "chunk.wav");
  form.append("model", process.env.GROQ_MODEL || "whisper-large-v3");
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  if (lang) form.append("language", lang);
  return fetchWithTimeout(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  }, timeoutMs, "Groq");
}

// MAI-Transcribe 2 via OpenRouter. With diarize, segments carry a numeric `speaker`.
export async function maiTranscribe(buf, { lang, format = "wav", diarize = false, timeoutMs = 55000 } = {}) {
  const body = {
    model: MAI_MODEL,
    input_audio: { data: Buffer.from(buf).toString("base64"), format },
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
  };
  if (lang) body.language = lang;
  if (diarize) body.provider = { options: { azure: { diarization: { enabled: true } } } };
  return fetchWithTimeout(`${OPENROUTER_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${openRouterKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, timeoutMs, "OpenRouter");
}

export async function openRouterChat(model, messages, { timeoutMs = 110000, maxTokens = 4000 } = {}) {
  const data = await fetchWithTimeout(`${OPENROUTER_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${openRouterKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, reasoning: { enabled: false } }),
  }, timeoutMs, "OpenRouter");
  return data?.choices?.[0]?.message?.content ?? "";
}

export async function openRouterModels() {
  return fetchWithTimeout(`${OPENROUTER_URL}/models`, { method: "GET" }, 15000, "OpenRouter");
}

export function sendError(res, err) {
  if (err instanceof ProviderError) {
    if (err.status >= 500) console.error(err.message);
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error(err);
  return res.status(500).json({ error: String(err?.message || err), code: "upstream" });
}

// Reads the raw body. Returns null when it exceeds maxBytes (rest is drained, not kept).
export async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  return tooLarge ? null : Buffer.concat(chunks, size);
}
