// Client for the transcription proxy (api/transcribe.js).

const ENDPOINT = "/api/transcribe";
const TIMEOUT_MS = 60000;
const RETRY_DELAYS_MS = [800, 2000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One request. Errors from HTTP responses carry `.status`; network errors and
// timeouts do not.
async function send(url, blob) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: blob,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(typeof data?.error === "string" ? data.error : `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return { text: (data?.text || "").trim(), language: data?.language || null };
  } catch (err) {
    if (err.status) throw err;
    throw new Error(err.name === "AbortError" ? "Zeitüberschreitung" : "Netzwerkfehler");
  } finally {
    clearTimeout(timer);
  }
}

export async function transcribeWav(blob, { lang } = {}) {
  let url = ENDPOINT;
  if (lang && /^[a-z]{2}$/i.test(lang)) url += `?lang=${lang.toLowerCase()}`;

  for (let attempt = 0; ; attempt++) {
    try {
      return await send(url, blob);
    } catch (err) {
      const retryable = !err.status || err.status >= 500 || err.status === 429;
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}
