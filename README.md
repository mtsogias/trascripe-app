# Whisperflow

Progressive Web App fürs iPhone: Aufnehmen → transkribieren → kopieren. Wie Whisperflow, nur stumpf und minimal.

## Features (v1)
- **Tab "Transcribe"**: Record-Button unten mittig. Beim Aufnehmen erscheint in Bildschirmmitte ein dezent animierter Waveform-Ring.
- Transkriptionen erscheinen chronologisch unten im selben Fenster.
- **Oben rechts "Copy All"**: kopiert alle aktuellen Transkriptionen als Block.
- **Oben rechts "Clear"**: wischt aktuellen Transkript-Screen (alte sind in Notes gesichert).
- **Tab "Notes"**: Auto-Archiv aller Transkriptionen in `localStorage`. Pro Notiz: Kopieren / Löschen.

## Architektur
- Statisches Frontend in `public/` (vanilla JS, kein Build-Step).
- Serverless Function `api/transcribe.js` als Proxy zu Groq → API-Key bleibt serverseitig.
- PWA-Manifest + Service Worker für Offline-Shell.

## Deploy auf Vercel

```bash
cd trascribe-app
npx vercel link          # Projekt verlinken / neu anlegen
npx vercel env add GROQ_API_KEY   # deinen Groq-Key setzen (secret)
npx vercel --prod
```

Danach in Safari auf dem iPhone öffnen → Teilen → "Zum Home-Bildschirm" → fertig als Bookmark-App.

## Groq-Key
- Hol dir einen unter https://console.groq.com.
- Modell: `whisper-large-v3` (fest in `api/transcribe.js`).
- Key wird NIE im Client ausgeliefert — nur in der Vercel-Env-Var `GROQ_API_KEY`.

## Lokal testen
```bash
npx vercel dev
```
Braucht ebenfalls `GROQ_API_KEY` in `.env.local`:
```
GROQ_API_KEY=gsk_...
```

## Endpunkte
- `GET /` → `public/index.html`
- `POST /api/transcribe` → `{ audio: "<base64>", mime: "audio/webm" }` → `{ text: "..." }`