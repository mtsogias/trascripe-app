const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL = "whisper-large-v3";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GROQ_API_KEY not set on server" });
  }

  try {
    const { audio, mime = "audio/webm" } = req.body || {};
    if (!audio) {
      return res.status(400).json({ error: "Missing audio field" });
    }

    const buf = Buffer.from(audio, "base64");
    const ext = mime.includes("webm") ? "webm" : mime.includes("mp4") ? "m4a" : "wav";
    const filename = `recording.${ext}`;

    const form = new FormData();
    const blob = new Blob([buf], { type: mime });
    form.append("file", blob, filename);
    form.append("model", MODEL);
    form.append("response_format", "json");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);

    let groqRes;
    try {
      groqRes = await fetch(GROQ_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error("Groq error:", groqRes.status, errText);
      return res.status(groqRes.status).json({ error: `Groq: ${errText}` });
    }

    const data = await groqRes.json();
    return res.status(200).json({ text: data.text || "" });
  } catch (err) {
    console.error("Transcribe error:", err);
    if (err.name === "AbortError") {
      return res.status(504).json({ error: "Groq timeout (audio too long?)" });
    }
    return res.status(500).json({ error: String(err) });
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "25mb",
    },
    maxDuration: 60,
  },
};