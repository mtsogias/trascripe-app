// Backup of all notes and folders in a private Vercel Blob store.
// GET returns the latest backup, PUT replaces it. Both need the password from BACKUP_PASSWORD.
import { createHash, timingSafeEqual } from "node:crypto";
import { get, put } from "@vercel/blob";

const LATEST = "backup/latest.json";
const MAX_BYTES = 4 * 1024 * 1024;

function sha256(text) {
  return createHash("sha256").update(text).digest();
}

function authorized(req, password) {
  const header = req.headers.authorization || "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Hashing first gives equal lengths, which timingSafeEqual needs.
  return given !== "" && timingSafeEqual(sha256(given), sha256(password));
}

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

async function sendBackup(res) {
  // useCache: false reads the newest version, not a CDN copy from before the last save.
  const result = await get(LATEST, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200) {
    return res.status(404).json({ error: "No backup yet" });
  }
  const text = await new Response(result.stream).text();
  res.setHeader("Content-Type", "application/json");
  return res.status(200).send(text);
}

async function saveBackup(req, res) {
  const buf = await readBody(req);
  if (buf === null) {
    return res.status(413).json({ error: "Backup too large" });
  }
  let data;
  try {
    data = JSON.parse(buf.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  if (!Array.isArray(data?.notes) || !Array.isArray(data?.folders)) {
    return res.status(400).json({ error: "Invalid backup" });
  }

  const savedAt = new Date().toISOString();
  const body = JSON.stringify({ savedAt, notes: data.notes, folders: data.folders });
  const options = { access: "private", allowOverwrite: true, addRandomSuffix: false, contentType: "application/json" };
  await put(LATEST, body, options);
  // One copy per day, so a bad save can never wipe out everything.
  await put(`backup/${savedAt.slice(0, 10)}.json`, body, options);
  return res.status(200).json({ savedAt });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const password = process.env.BACKUP_PASSWORD;
  if (!password) {
    return res.status(500).json({ error: "BACKUP_PASSWORD not set on server" });
  }
  if (!authorized(req, password)) {
    return res.status(401).json({ error: "Wrong password" });
  }

  try {
    if (req.method === "GET") return await sendBackup(res);
    if (req.method === "PUT") return await saveBackup(req, res);
    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ error: "Method Not Allowed" });
  } catch (err) {
    console.error("Backup error:", err);
    return res.status(500).json({ error: "Backup storage failed" });
  }
}
