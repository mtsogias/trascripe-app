# Whisperflow

Progressive Web App fürs iPhone: Aufnehmen → transkribieren → bearbeiten → kopieren.

## Features
- **Notizen-Liste** mit Suche, gruppiert nach Heute / Gestern / Letzte 7 Tage / Älter. Kopieren direkt aus der Liste.
- **Aufnahme** (roter Knopf unten): Vollbild-Ansicht mit Waveform, Timer und Live-Text. Nach dem Stoppen öffnet sich die Notiz im Editor.
- **Editor**: Text frei bearbeiten (speichert automatisch), Kopieren, Teilen, Löschen mit „Widerrufen“.
- **Diktieren im Editor**: Mikrofon-Knopf fügt neu gesprochenen Text an der Cursor-Position ein.
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
  `js/app.js` (UI), `js/session.js` (Aufnahme-Ablauf), `js/recorder.js` + `js/pcm-worklet.js` (Mikrofon), `js/vad.js` (Sprach-Erkennung/Schnitt), `js/audio-utils.js` (Resampling/WAV), `js/api.js`, `js/store.js`, `js/waveform.js`.
- Serverless Function `api/transcribe.js` als Proxy zu Groq → API-Key bleibt serverseitig.
- Service Worker (`public/sw.js`): network-first, offline Fallback auf den Cache.

## Deploy auf Vercel

```bash
npx vercel link
npx vercel env add GROQ_API_KEY
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
Braucht `GROQ_API_KEY` in `.env.local`.

## Endpunkt
`POST /api/transcribe[?lang=de]`, Body: WAV (`Content-Type: audio/wav`) → `{ text, language, dropped }`
