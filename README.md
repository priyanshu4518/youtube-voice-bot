# YouTube AI Assistant (Gemini + RAG + Cartesia TTS)

A Chrome extension (Manifest V3) that answers questions about the YouTube video you're watching.
Answers are grounded **only in transcript content up to the current playback position**, so there are no spoilers. Answers are text, and can optionally be read aloud with Cartesia's Sonic text-to-speech.

```
extension/   Chrome popup (HTML/CSS/JS) – reads video id + currentTime, calls the backend
backend/     FastAPI (async)
  main.py                  entry point (`uvicorn main:app`)
  app/__init__.py          app factory: startup/shutdown, middleware, shared services
  app/config.py            every setting, read once from .env
  app/api.py               routes: /transcript, /ask, /ask/stream, /speak, /health
  app/core/cache.py        LRU cache + single-flight request coalescing
  app/core/timing.py       per-request latency log + Server-Timing header
  app/services/transcript.py  fetches transcript (adapted from test.py, youtube-transcript-api)
  app/services/retrieval.py   30s chunking, local all-MiniLM-L6-v2 embeddings, memory + disk index cache, search
  app/services/llm.py         prompt building, streamed answers, Gemini -> OpenRouter failover and hedging
  app/services/tts.py         Cartesia text-to-speech (Sonic), streamed audio, audio cache
test.py      your original transcript script (unchanged)
```

**Latency work:** see [OPTIMIZATIONS.md](OPTIMIZATIONS.md) for what was changed for speed, why, and the measured impact.

## How it works
1. Popup reads the video id and `video.currentTime` from the active YouTube tab.
2. `/transcript` fetches the transcript, splits it into ~30s timestamped chunks and returns. The chunks are then embedded locally with `all-MiniLM-L6-v2` in the background (no API key; the model downloads on first use), usually while you type. Each video's index is cached in memory and in `backend/cache/`, so it survives restarts. Gemini is used only for the final answer.
3. `/ask/stream` **first drops every chunk whose start time is after `current_time`**, then ranks the remaining chunks by cosine similarity to the question and sends the top 5 to Gemini. The boundary chunk is also trimmed so text after the current position is never sent. If Gemini is slow or fails, OpenRouter is used (see [OPTIMIZATIONS.md](OPTIMIZATIONS.md)).
4. The answer streams into the popup as it is generated; `[m:ss]` citations are clickable and seek the video.
5. **Speak answer** sends the answer text to `/speak`. The backend strips the `[m:ss]` citations, calls Cartesia's TTS API with the official Python SDK, and streams MP3 audio back. The popup starts playing as soon as the first audio arrives, with standard audio controls.

## Run the backend
```powershell
cd backend
..\venv\Scripts\activate          # or create your own venv
pip install -r requirements.txt
copy .env.example .env            # then put your GEMINI_API_KEY and CARTESIA_API_KEY in .env
uvicorn main:app --reload --port 8000
```
Get a Gemini key at https://aistudio.google.com/apikey and a Cartesia key at https://play.cartesia.ai/keys. Both keys stay in `backend/.env`; the extension never sees them.

### Text-to-speech settings (`backend/.env`)
| Variable | Default | Notes |
|---|---|---|
| `CARTESIA_API_KEY` | none | Required for `/speak`. Without it, `/speak` returns 500. `/transcript` and `/ask` still work. |
| `CARTESIA_MODEL` | `sonic-3.6` | `sonic-3.6` tracks the latest Sonic 3.6 snapshot. To keep output fixed, pin a dated snapshot such as `sonic-3.6-2026-08-27`. |
| `CARTESIA_VOICE_ID` | `e07c00bc-4134-4eae-9ea4-1a55fb45746b` | The voice from Cartesia's SDK example. You can use any voice ID from the [Cartesia playground](https://play.cartesia.ai/voices). |
| `CARTESIA_LANGUAGE` | `en` | Language code sent to Cartesia. It should match the voice's language. |

Audio is MP3 at 44.1 kHz and 128 kbps. Speech text is limited to 5,000 characters.

## Load the extension
1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Open a YouTube video (`youtube.com/watch?v=...`), pause/play to any point, click the extension icon, wait for "Ready", and ask a question.
4. **Voice input (optional, free):** click the 🎤 mic button next to the question box and speak. The words appear in the box as you talk; recognition stops after a pause (or click the button again to stop). Edit the text if needed, then press Enter/Send. The first time, Chrome can't show a mic prompt inside a popup, so the extension opens a small tab asking for microphone access; click **Allow**, the tab closes itself, then reopen the extension.
5. Click **Speak answer** under the answer. The button reads "Generating audio…" while the audio is generated. Playback then starts, and the player gives you pause, seek and volume. Click **Stop** to end playback. Starting a new clip or asking a new question stops the current one. Audio memory is freed when playback ends, when you stop it, or when you close the popup.

## Swapping the transcript source
Edit only `fetch_transcript()` in `backend/app/services/transcript.py`. It must return `[{"text", "start", "duration"}, ...]` (seconds).

## API
- `POST /transcript` `{"video_id": "..."}` → `{"chunks": [{"start","end","text"}]}`
- `POST /ask` `{"video_id","question","current_time"}` → `{"answer","sources":[{"start","text"}]}` (unchanged)
- `POST /ask/stream` same body as `/ask` → newline-delimited JSON (`application/x-ndjson`), one event per line:
  `{"type":"sources","sources":[...]}`, then `{"type":"delta","text":"..."}` as text is generated, then `{"type":"done"}` or `{"type":"error","detail":"..."}`. Errors before the first text are normal HTTP errors, like `/ask`.
- `GET /health` → model/cache/config status.
- `video_id` must be an 11-character YouTube id; anything else returns 422.
- Every response has a `Server-Timing` header with per-stage timings (DevTools → Network → Timing).
- `POST /speak` `{"text"}` → `audio/mpeg` bytes, streamed. Errors return JSON `{"detail"}`:
  - 400: the text is empty, or contains only citations
  - 422: the text is missing or longer than 5,000 characters
  - 429: Cartesia rate limit
  - 500: no API key is set
  - 502: Cartesia returned an error or no audio
  - 504: the request to Cartesia timed out

Quick test from PowerShell while the backend is running:
```powershell
Invoke-WebRequest -Method Post -Uri http://localhost:8000/speak -ContentType 'application/json' `
  -Body '{"text":"Hello from the YouTube AI Assistant [0:42]."}' -OutFile speak.mp3
start speak.mp3
```

## Notes / limitations
- Video indexes are cached in memory and on disk in `backend/cache/`. Delete that folder to force transcripts to be fetched again.
- Chunk embeddings of the chunk containing the current position may include a few seconds of later text; this only affects ranking, never the text sent to Gemini.
- YouTube sometimes blocks transcript requests from cloud IPs; running locally is fine.
- Voice input uses the browser's built-in Web Speech API (no API key, no cost). In Chrome it sends audio to Google's speech service, so it needs internet. It isn't available in Firefox and some Chromium forks (e.g. Brave); there the mic shows an "unsupported" message and typing still works.
- If you blocked the microphone, re-allow it at `chrome://settings/content/microphone` (look for the extension's `chrome-extension://` entry).
- The first **Speak answer** for an answer makes a Cartesia request, which uses Cartesia credits. The audio is then cached in memory (`TTS_CACHE_MB`, default 64 MB), so speaking the same answer again is instant and free until the server restarts.
