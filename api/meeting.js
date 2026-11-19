// Meeting transcription with speakers. A recording is uploaded in pieces (Vercel caps request bodies at
// ~4.5 MB) to the private Blob store, then joined and sent to MAI-Transcribe 2 in one request.
//   POST ?action=upload&id=<id>&file=<n>&part=<p>        body: raw bytes of one piece
//   POST ?action=transcribe&id=<id>&file=<n>&parts=<count>&lang=de
//        → { segments: [{ start, end, speaker, text }], duration, language }
//   POST ?action=discard&id=<id>                         deletes all pieces of the meeting
// Pieces are deleted after every transcribe attempt; the phone keeps its copy for retries.
import { del, get, list, put } from "@vercel/blob";
import { toLangCode } from "./_filter.js";
import { ProviderError, maiTranscribe, readBody, sendError } from "./_providers.js";

const PIECE_MAX = 4 * 1024 * 1024;
const FILE_MAX = 18 * 1024 * 1024; // OpenRouter rejects inline audio above 25 MB (base64 adds a third)
const MAX_PARTS = 16;
const ID_RE = /^[a-z0-9-]{8,64}$/i;

const prefix = (id, file) => `meetings/${id}/${file}/`;
const piecePath = (id, file, part) => `${prefix(id, file)}${String(part).padStart(3, "0")}`;

async function readPiece(pathname) {
  const result = await get(pathname, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200) return null;
  return Buffer.from(await new Response(result.stream).arrayBuffer());
}

async function deletePrefix(pathPrefix) {
  let cursor;
  do {
    const page = await list({ prefix: pathPrefix, cursor });
    if (page.blobs.length) await del(page.blobs.map((b) => b.url));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
}

async function upload(req, res, id, file, part) {
  const buf = await readBody(req, PIECE_MAX);
  if (buf === null) return res.status(413).json({ error: "Piece too large", code: "bad" });
  if (!buf.length) return res.status(400).json({ error: "Empty piece", code: "bad" });
  await put(piecePath(id, file, part), buf, {
    access: "private",
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: "application/octet-stream",
  });
  return res.status(200).json({ ok: true });
}

async function transcribe(res, id, file, parts, lang) {
  try {
    const pieces = [];
    let size = 0;
    for (let p = 0; p < parts; p++) {
      const piece = await readPiece(piecePath(id, file, p));
      if (!piece) return res.status(409).json({ error: `Piece ${p} missing`, code: "missing" });
      size += piece.length;
      if (size > FILE_MAX) return res.status(413).json({ error: "Recording part too large", code: "bad" });
      pieces.push(piece);
    }
    const data = await maiTranscribe(Buffer.concat(pieces, size), {
      lang,
      format: "wav",
      diarize: true,
      timeoutMs: 270000,
    });
    const segments = (Array.isArray(data?.segments) ? data.segments : [])
      .map((s) => ({
        start: Number(s.start) || 0,
        end: Number(s.end) || 0,
        speaker: Number.isInteger(s.speaker) ? s.speaker : null,
        text: String(s.text ?? "").trim(),
      }))
      .filter((s) => s.text);
    return res.status(200).json({
      segments,
      duration: Number(data?.duration) || null,
      language: toLangCode(data?.language) ?? lang,
    });
  } finally {
    await deletePrefix(prefix(id, file)).catch((err) => console.error("Meeting cleanup failed:", err));
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const params = new URL(req.url || "/", "http://x").searchParams;
  const action = params.get("action");
  const id = params.get("id") || "";
  const file = Number(params.get("file") ?? 0);
  if (!ID_RE.test(id) || !Number.isInteger(file) || file < 0 || file > 99) {
    return res.status(400).json({ error: "Invalid meeting id or file", code: "bad" });
  }

  try {
    if (action === "upload") {
      const part = Number(params.get("part"));
      if (!Number.isInteger(part) || part < 0 || part >= MAX_PARTS) {
        return res.status(400).json({ error: "Invalid part", code: "bad" });
      }
      return await upload(req, res, id, file, part);
    }
    if (action === "transcribe") {
      const parts = Number(params.get("parts"));
      if (!Number.isInteger(parts) || parts < 1 || parts > MAX_PARTS) {
        return res.status(400).json({ error: "Invalid parts", code: "bad" });
      }
      const lang = /^[a-z]{2}$/.test(params.get("lang") || "") ? params.get("lang") : null;
      return await transcribe(res, id, file, parts, lang);
    }
    if (action === "discard") {
      await deletePrefix(`meetings/${id}/`);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: "Unknown action", code: "bad" });
  } catch (err) {
    if (!(err instanceof ProviderError) && /blob/i.test(String(err?.name || err?.message))) {
      console.error("Blob error:", err);
      return res.status(502).json({ error: "Storage failed", code: "upstream" });
    }
    return sendError(res, err);
  }
}
