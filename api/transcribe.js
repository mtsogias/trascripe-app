// Transcribes one WAV chunk. POST /api/transcribe?provider=groq|mai&lang=de, body: audio/wav.
import { filterTranscription, toLangCode } from "./_filter.js";
import { groqTranscribe, maiTranscribe, readBody, sendError } from "./_providers.js";

const MAX_BYTES = 4 * 1024 * 1024;
const MIN_BYTES = 44; // WAV header size

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  let buf;
  try {
    buf = await readBody(req, MAX_BYTES);
  } catch {
    return res.status(400).json({ error: "Could not read request body", code: "bad" });
  }
  if (buf === null) return res.status(413).json({ error: "Audio chunk too large", code: "bad" });
  if (buf.length < MIN_BYTES) return res.status(400).json({ error: "Audio chunk too short", code: "bad" });

  const params = new URL(req.url || "/", "http://x").searchParams;
  const lang = /^[a-z]{2}$/.test(params.get("lang") || "") ? params.get("lang") : null;
  const provider = params.get("provider") === "mai" ? "mai" : "groq";

  try {
    const data = provider === "mai" ? await maiTranscribe(buf, { lang }) : await groqTranscribe(buf, { lang });
    const { text, dropped } = filterTranscription(data);
    return res.status(200).json({ text, language: toLangCode(data?.language) ?? lang, dropped, provider });
  } catch (err) {
    return sendError(res, err);
  }
}
