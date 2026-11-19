// Summaries via OpenRouter.
//   POST { text, model }  → { summary }
//   GET  ?models          → { models: [{ id, name, prompt, completion }] }  (text models, $ per 1M tokens)
import { openRouterChat, openRouterModels, readBody, sendError } from "./_providers.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MODEL_RE = /^~?[a-z0-9._-]+\/[a-z0-9._:-]+$/i;
export const DEFAULT_MODEL = "~deepseek/deepseek-flash-latest";

const PROMPT = `Du fasst Notizen und Meeting-Transkripte zusammen. Antworte in der Sprache des Textes.
Gib reinen Text ohne Markdown aus (keine Sternchen, keine Rauten), genau in dieser Form:

Zusammenfassung
<3 bis 8 kurze Sätze: worum es ging, was entschieden wurde>

To-dos
• <Aufgabe> (<wer, falls genannt>)

Wenn es keine Aufgaben gibt, schreibe unter "To-dos" nur "• Keine".
Verwende die Namen der Sprecher genau so, wie sie im Text stehen (z. B. "Sprecher 1").
Erfinde nichts, was nicht im Text steht.`;

const perMillion = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1000) / 1000 : null;
};

async function models(res) {
  const data = await openRouterModels();
  const list = (Array.isArray(data?.data) ? data.data : [])
    .filter((m) => (m.architecture?.output_modalities ?? ["text"]).includes("text"))
    .filter((m) => (m.architecture?.input_modalities ?? ["text"]).includes("text"))
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      prompt: perMillion(m.pricing?.prompt),
      completion: perMillion(m.pricing?.completion),
    }))
    .filter((m) => m.prompt !== null && m.prompt >= 0)
    .filter((m) => !m.id.endsWith(":batch")); // batch variants answer later, not in the same request
  res.setHeader("Cache-Control", "public, max-age=3600");
  return res.status(200).json({ models: list });
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") return await models(res);
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method Not Allowed" });
    }
    const buf = await readBody(req, MAX_BYTES);
    if (buf === null) return res.status(413).json({ error: "Text too long", code: "bad" });
    let body;
    try {
      body = JSON.parse(buf.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "Invalid JSON", code: "bad" });
    }
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "No text", code: "bad" });
    const model = MODEL_RE.test(body?.model || "") ? body.model : DEFAULT_MODEL;

    const summary = await openRouterChat(model, [
      { role: "system", content: PROMPT },
      { role: "user", content: text },
    ]);
    if (!summary.trim()) return res.status(502).json({ error: "Empty summary", code: "upstream" });
    return res.status(200).json({ summary: summary.trim(), model });
  } catch (err) {
    return sendError(res, err);
  }
}
