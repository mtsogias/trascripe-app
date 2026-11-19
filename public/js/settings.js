// User settings in localStorage.

const KEY = "whisperflow.settings.v1";

export const PROVIDERS = {
  groq: "Groq Whisper",
  mai: "Microsoft MAI",
};

export const DEFAULTS = {
  provider: "groq", // transcription of normal recordings and dictation
  fallback: true, // use the other provider when the chosen one fails
  summaryModel: "~deepseek/deepseek-flash-latest",
};

export function get() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    const merged = { ...DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) };
    if (!PROVIDERS[merged.provider]) merged.provider = DEFAULTS.provider;
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export function set(patch) {
  const next = { ...get(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  return next;
}
