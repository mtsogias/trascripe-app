# Whisperflow

Progressive Web App fürs iPhone: Aufnehmen → transkribieren → bearbeiten → kopieren.

## Features
- **Notizen-Liste** mit Suche, gruppiert nach Heute / Gestern / Letzte 7 Tage / Älter. Kopieren direkt aus der Liste.
- **Aufnahme** (roter Knopf unten): Vollbild-Ansicht mit Waveform, Timer und Live-Text. Nach dem Stoppen öffnet sich die Notiz im Editor.
- **Editor**: Text frei bearbeiten (speichert automatisch), Kopieren, Teilen, Löschen mit „Widerrufen“.
- **Diktieren im Editor**: Mikrofon-Knopf fügt neu gesprochenen Text an der Cursor-Position ein.
- **Meeting-Modus** (Knopf „Meeting“): nimmt das ganze Gespräch auf dem Gerät auf und schickt es am Ende an Microsoft MAI-Transcribe 2 (über OpenRouter). Ergebnis mit Sprechern und Zeiten (`[0:06] Sprecher 2: …`), Sprecher lassen sich im Editor benennen.
- **Nichts geht verloren**: Jeder Abschnitt wird vor dem Senden auf dem Gerät gesichert (IndexedDB). Scheitert das Senden, steht in der Notiz `[⏳ 3:42–4:10 wird nachgereicht]`; die App schickt ihn automatisch nach (oder „Erneut senden“). Bei leerem Guthaben/ungültigem Schlüssel kommt eine klare Meldung.
- **Ersatz-Anbieter**: Fällt Groq aus, springt Microsoft ein (und umgekehrt), abschaltbar.
- **Zusammenfassung** (✨ im Editor): Zusammenfassung + To-dos über OpenRouter, Modell in den Einstellungen wählbar.
- **Einstellungen** (⋯ oben rechts): Transkriptions-Modell, Ersatz-Anbieter, Modell für Zusammenfassungen.
- **Aufnahme-Protokoll** (Seitenleiste): Diagnose der letzten 10 Aufnahmen zum Kopieren.
- Notizen liegen in `localStorage` (alte Notizen aus v1 werden automatisch übernommen).

## Schutz gegen Halluzinationen
Whisper erfindet bei Stille gern Text („Untertitel im Auftrag des ZDF“ …). Dagegen:
1. **Lückenlose Aufnahme** als 16-kHz-PCM (AudioWorklet), keine abgeschnittenen Wörter zwischen Abschnitten.
2. **Sprach-Erkennung auf dem Gerät** (`public/js/vad.js`): Abschnitte ohne Sprache werden **nie** gesendet.
3. **Schnitt an Sprechpausen** (nach ≥10 s an einer Pause, spätestens nach 28 s).
4. **Server-Filter** (`api/_filter.js`): Whisper-Segmente mit hoher „no speech“-Wahrscheinlichkeit, niedriger Konfidenz oder Wiederholungsschleifen werden verworfen, ebenso bekannte Phantom-Sätze.
5. **Sprache wird pro Aufnahme fixiert**, sobald der erste Abschnitt erkannt ist.

## Architektur
- Statisches Frontend in `public/` (Vanilla JS, ES-Module, kein Build-Step):
  `js/app.js` (UI), `js/session.js` (Aufnahme-Ablauf), `js/recorder.js` + `js/pcm-worklet.js` (Mikrofon), `js/vad.js` (Sprach-Erkennung/Schnitt), `js/audio-utils.js` (Resampling/WAV), `js/api.js` (Server-Aufrufe, Ersatz-Anbieter), `js/pending.js` (gesicherte Abschnitte + Nachreichen), `js/meeting.js` + `js/meeting-merge.js` + `js/adpcm.js` (Meeting-Modus), `js/idb.js`, `js/settings.js`, `js/diag.js`, `js/store.js`, `js/waveform.js`.
- Serverless Functions (API-Keys bleiben serverseitig):
  - `api/transcribe.js`: ein Abschnitt, `?provider=groq|mai`.
  - `api/meeting.js`: Meeting-Aufnahme in Stücken in den privaten Blob-Store hochladen, zusammensetzen, an MAI senden, Stücke löschen.
  - `api/summarize.js`: Zusammenfassung; `GET ?models` liefert die OpenRouter-Modell-Liste.
- Meeting-Audio: eigener IMA-ADPCM-Encoder (16 kHz, ~29 MB/Std.), weil MAI das AAC/WebM des iPhones nicht annimmt. Lange Meetings werden in 30-Minuten-Teile mit 90 s Überlappung zerlegt; die Sprecher werden in der Überlappung zugeordnet.
- Service Worker (`public/sw.js`): network-first, offline Fallback auf den Cache.

## Deploy auf Vercel

```bash
npx vercel link
npx vercel env add GROQ_API_KEY
npx vercel env add OPENROUTER_API_KEY
npx vercel --prod
```

Danach in Safari auf dem iPhone öffnen → Teilen → „Zum Home-Bildschirm“. (Bei neuem Icon: alte Verknüpfung entfernen und neu hinzufügen.)

## Groq
- Key unter https://console.groq.com, nur als Vercel-Env-Var `GROQ_API_KEY`.
- Modell: `whisper-large-v3` (überschreibbar per Env-Var `GROQ_MODEL`).

## Lokal testen
```bash
npx vercel dev
```
Braucht `GROQ_API_KEY` und `OPENROUTER_API_KEY` in `.env.local`.

## Endpunkt
`POST /api/transcribe[?provider=groq|mai&lang=de]`, Body: WAV (`Content-Type: audio/wav`) → `{ text, language, dropped, provider }`. Fehler: `{ error, code }` mit `code` = credits | key | config | rate | bad | upstream.
