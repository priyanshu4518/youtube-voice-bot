# YouTube AI Assistant (Gemini + RAG + Cartesia TTS)

A Chrome extension (Manifest V3) that answers questions about the YouTube video you're watching.
Answers are grounded **only in transcript content up to the current playback position**, so there are no spoilers. Answers are text, and can optionally be read aloud with Cartesia's Sonic text-to-speech.

```
extension/   Chrome popup (HTML/CSS/JS) – reads video id + currentTime, calls the backend
backend/     FastAPI
  transcript.py   fetches transcript (adapted from test.py, youtube-transcript-api)
  retrieval.py    30s chunking, local all-MiniLM-L6-v2 embeddings, timestamp filter, cosine search (numpy)
  gemini.py       prompt building + answer generation
  tts.py          Cartesia text-to-speech (Sonic), citation stripping
  main.py         POST /transcript, POST /ask, POST /speak, CORS
test.py      your original transcript script (unchanged)
```

## How it works
1. Popup reads the video id and `video.currentTime` from the active YouTube tab.
2. `/transcript` fetches the transcript, splits it into ~30s timestamped chunks, embeds them locally with `all-MiniLM-L6-v2` (no API key; the model downloads on first use; cached in memory per video). Gemini is used only for the final answer.
3. `/ask` **first drops every chunk whose start time is after `current_time`**, then ranks the remaining chunks by cosine similarity to the question and sends the top 5 to Gemini. The boundary chunk is also trimmed so text after the current position is never sent.
4. The answer appears in the popup; `[m:ss]` citations are clickable and seek the video.
5. **Speak answer** sends the answer text to `/speak`. The backend strips the `[m:ss]` citations, calls Cartesia's TTS API with the official Python SDK, and returns MP3 audio. The popup plays it with standard audio controls.

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
Edit only `fetch_transcript()` in `backend/transcript.py`. It must return `[{"text", "start", "duration"}, ...]` (seconds).

## API
- `POST /transcript` `{"video_id": "..."}` → `{"chunks": [{"start","end","text"}]}`
- `POST /ask` `{"video_id","question","current_time"}` → `{"answer","sources":[{"start","text"}]}` (unchanged)
- `POST /speak` `{"text"}` → `audio/mpeg` bytes. Errors return JSON `{"detail"}`:
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
- Embedding cache is in-memory; it resets when the server restarts.
- Chunk embeddings of the chunk containing the current position may include a few seconds of later text; this only affects ranking, never the text sent to Gemini.
- YouTube sometimes blocks transcript requests from cloud IPs; running locally is fine.
- Voice input uses the browser's built-in Web Speech API (no API key, no cost). In Chrome it sends audio to Google's speech service, so it needs internet. It isn't available in Firefox and some Chromium forks (e.g. Brave); there the mic shows an "unsupported" message and typing still works.
- If you blocked the microphone, re-allow it at `chrome://settings/content/microphone` (look for the extension's `chrome-extension://` entry).
- Each **Speak answer** click makes a new Cartesia request, and each request uses Cartesia credits. Audio is not cached.
