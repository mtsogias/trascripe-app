# Transcribe App

Speak instead of type – on your iPhone. Record, transcribe automatically, edit, copy. Works for whole meetings too, with speakers and a summary.

**Live:** https://trascripe-app.vercel.app (open in Safari → Share → "Add to Home Screen")

## Features
- **Dictation & notes**: recording with live text, editor, folders, search, swipe gestures.
- **Meeting mode**: records entire conversations and returns a transcript with speakers and timestamps (`[0:06] Speaker 2: …`).
- **AI summary**: summary and to-dos at the push of a button, with a selectable model.
- **Nothing gets lost**: every chunk is saved on the device first; if sending fails, it is retried automatically.
- **Failover**: if one transcription provider goes down, the other takes over.
- **No made-up sentences**: on-device voice detection and a server-side filter prevent typical Whisper hallucinations during silence.

## Tech
- Frontend: vanilla JavaScript (ES modules, no build step), Progressive Web App with a service worker
- Audio: AudioWorklet (16 kHz PCM), custom voice activity detection, custom IMA ADPCM encoder for long meetings
- Backend: Vercel Serverless Functions, Vercel Blob (backup, meeting uploads)
- AI: Groq Whisper, Microsoft MAI-Transcribe (via OpenRouter), LLMs via OpenRouter

## Run locally
```bash
npx vercel dev   # requires GROQ_API_KEY and OPENROUTER_API_KEY in .env.local
```
