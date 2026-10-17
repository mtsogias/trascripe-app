// Pure filtering helpers for Whisper output. No I/O, no dependencies.

const STRONG_CONTAINS = [
  "amara org",
  "untertitel im auftrag",
  "untertitelung im auftrag",
  "untertitel der amara",
  "untertitelung des zdf",
  "untertitel des zdf",
  "im auftrag des zdf",
  "untertitel von stephanie geiges",
  "subtitles by",
  "subtitled by",
  "captions by",
  "transcribed by",
  "transcription by",
  "copyright wdr",
  "swr 2021",
  "www zdf de",
];

const STRONG_EQUALS = [
  "vielen dank fürs zuschauen",
  "danke fürs zuschauen",
  "vielen dank für ihre aufmerksamkeit",
  "thanks for watching",
  "thank you for watching",
  "thank you so much for watching",
  "please subscribe",
  "like and subscribe",
  "abonniert den kanal",
  "untertitel",
  "untertitelung",
  "musik",
  "music",
  "applaus",
  "lachen",
];

const WEAK_EQUALS = [
  "vielen dank",
  "danke",
  "danke schön",
  "dankeschön",
  "thank you",
  "thanks",
  "tschüss",
  "bye",
  "bis zum nächsten mal",
  "bis bald",
  "ok",
  "okay",
  "ja",
  "so",
];

const LANG_NAMES = new Map(
  Object.entries({
    german: "de", english: "en", french: "fr", spanish: "es", italian: "it",
    dutch: "nl", portuguese: "pt", polish: "pl", turkish: "tr", russian: "ru",
    greek: "el", ukrainian: "uk", swedish: "sv", danish: "da", norwegian: "no",
    finnish: "fi", czech: "cs", arabic: "ar", croatian: "hr", serbian: "sr",
    romanian: "ro", hungarian: "hu",
  }),
);

export function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isBlockedText(text) {
  const n = normalize(text);
  return STRONG_EQUALS.includes(n) || STRONG_CONTAINS.some((p) => n.includes(p));
}

// Missing or non-numeric fields count as "not suspicious".
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function shouldDropSegment(seg) {
  const text = normalize(seg?.text);
  if (!text) return true;

  const noSpeech = num(seg?.no_speech_prob);
  const logprob = num(seg?.avg_logprob);
  const compression = num(seg?.compression_ratio);

  if (noSpeech >= 0.6 && logprob <= -0.7) return true;
  if (noSpeech >= 0.85) return true;
  if (compression > 2.4) return true;
  if (STRONG_CONTAINS.some((p) => text.includes(p))) return true;
  if (STRONG_EQUALS.includes(text)) return true;
  if (WEAK_EQUALS.includes(text) && (noSpeech >= 0.2 || logprob <= -0.5)) return true;
  return false;
}

export function filterTranscription(data) {
  if (Array.isArray(data?.segments)) {
    const kept = data.segments.filter((s) => !shouldDropSegment(s));
    const text = kept
      .map((s) => String(s.text ?? "").trim())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return { text, dropped: data.segments.length - kept.length };
  }

  const text = String(data?.text ?? "").trim();
  if (isBlockedText(text)) return { text: "", dropped: 1 };
  return { text, dropped: 0 };
}

export function toLangCode(lang) {
  if (typeof lang !== "string") return null;
  if (/^[a-z]{2}$/i.test(lang)) return lang.toLowerCase();
  return LANG_NAMES.get(lang.toLowerCase()) ?? null;
}
