# Transcribe App

Sprechen statt tippen – auf dem iPhone. Aufnehmen, automatisch transkribieren, bearbeiten, kopieren. Auch für ganze Meetings, mit Sprechern und Zusammenfassung.

**Live:** https://trascripe-app.vercel.app (in Safari öffnen → Teilen → „Zum Home-Bildschirm“)

## Was die App kann
- **Diktieren & Notizen**: Aufnahme mit Live-Text, Editor, Ordner, Suche, Wischgesten.
- **Meeting-Modus**: nimmt ganze Gespräche auf und liefert ein Protokoll mit Sprechern und Zeitstempeln (`[0:06] Sprecher 2: …`).
- **KI-Zusammenfassung**: Zusammenfassung und To-dos per Knopfdruck, Modell frei wählbar.
- **Nichts geht verloren**: Jeder Abschnitt wird erst auf dem Gerät gesichert; scheitert das Senden, wird automatisch nachgereicht.
- **Ausfallsicher**: Fällt ein Transkriptions-Anbieter aus, springt der andere ein.
- **Keine erfundenen Sätze**: Sprach-Erkennung auf dem Gerät und Server-Filter verhindern typische Whisper-Halluzinationen bei Stille.

## Technik
- Frontend: Vanilla JavaScript (ES-Module, kein Build-Step), Progressive Web App mit Service Worker
- Audio: AudioWorklet (16-kHz-PCM), eigene Sprach-Erkennung, eigener IMA-ADPCM-Encoder für lange Meetings
- Backend: Vercel Serverless Functions, Vercel Blob (Backup, Meeting-Uploads)
- KI: Groq Whisper, Microsoft MAI-Transcribe (über OpenRouter), LLMs über OpenRouter

## Selbst starten
```bash
npx vercel dev   # braucht GROQ_API_KEY und OPENROUTER_API_KEY in .env.local
```
