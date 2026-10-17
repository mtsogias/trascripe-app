import { filterTranscription, toLangCode } from "./_filter.js";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MAX_BYTES = 4 * 1024 * 1024;
const MIN_BYTES = 44; // WAV header size
const TIMEOUT_MS = 55000;

// Reads the raw body. Returns null when it exceeds MAX_BYTES (rest is drained, not kept).
async function readBody(req) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  return tooLarge ? null : Buffer.concat(chunks, size);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GROQ_API_KEY not set on server" });
  }

  let buf;
  try {
    buf = await readBody(req);
  } catch {
    return res.status(400).json({ error: "Could not read request body" });
  }
  if (buf === null) {
    return res.status(413).json({ error: "Audio chunk too large" });
  }
  if (buf.length < MIN_BYTES) {
    return res.status(400).json({ error: "Audio chunk too short" });
  }

  const lang = new URL(req.url || "/", "http://x").searchParams.get("lang");
  const langParam = lang && /^[a-z]{2}$/.test(lang) ? lang : null;

  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/wav" }), "chunk.wav");
  form.append("model", process.env.GROQ_MODEL || "whisper-large-v3");
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  if (langParam) form.append("language", langParam);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const groqRes = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error("Groq error:", groqRes.status, errText);
      return res.status(groqRes.status).json({ error: `Groq: ${errText}` });
    }

    const data = await groqRes.json();
    const { text, dropped } = filterTranscription(data);
    return res.status(200).json({ text, language: toLangCode(data?.language), dropped });
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({ error: "Transcription timeout" });
    }
    console.error("Transcribe error:", err);
    return res.status(500).json({ error: String(err) });
  } finally {
    clearTimeout(timer);
  }
}
