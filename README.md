# YouTube AI Assistant (Gemini + RAG)

A Chrome extension (Manifest V3) that answers questions about the YouTube video you're watching.
Answers are grounded **only in transcript content up to the current playback position**, so there are no spoilers. Text output only.

```
extension/   Chrome popup (HTML/CSS/JS) – reads video id + currentTime, calls the backend
backend/     FastAPI
  transcript.py   fetches transcript (adapted from test.py, youtube-transcript-api)
  retrieval.py    30s chunking, local all-MiniLM-L6-v2 embeddings, timestamp filter, cosine search (numpy)
  gemini.py       prompt building + answer generation
  main.py         POST /transcript, POST /ask, CORS
test.py      your original transcript script (unchanged)
```

## How it works
1. Popup reads the video id and `video.currentTime` from the active YouTube tab.
2. `/transcript` fetches the transcript, splits it into ~30s timestamped chunks, embeds them locally with `all-MiniLM-L6-v2` (no API key; the model downloads on first use; cached in memory per video). Gemini is used only for the final answer.
3. `/ask` **first drops every chunk whose start time is after `current_time`**, then ranks the remaining chunks by cosine similarity to the question and sends the top 5 to Gemini. The boundary chunk is also trimmed so text after the current position is never sent.
4. The answer appears in the popup; `[m:ss]` citations are clickable and seek the video.

## Run the backend
```powershell
cd backend
..\venv\Scripts\activate          # or create your own venv
pip install -r requirements.txt
copy .env.example .env            # then put your GEMINI_API_KEY in .env
uvicorn main:app --reload --port 8000
```
Get a key at https://aistudio.google.com/apikey. The key stays in `backend/.env`; the extension never sees it.

## Load the extension
1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Open a YouTube video (`youtube.com/watch?v=...`), pause/play to any point, click the extension icon, wait for "Ready", and ask a question.

## Swapping the transcript source
Edit only `fetch_transcript()` in `backend/transcript.py`. It must return `[{"text", "start", "duration"}, ...]` (seconds).

## API
- `POST /transcript` `{"video_id": "..."}` → `{"chunks": [{"start","end","text"}]}`
- `POST /ask` `{"video_id","question","current_time"}` → `{"answer","sources":[{"start","text"}]}`

## Notes / limitations
- Embedding cache is in-memory; it resets when the server restarts.
- Chunk embeddings of the chunk containing the current position may include a few seconds of later text; this only affects ranking, never the text sent to Gemini.
- YouTube sometimes blocks transcript requests from cloud IPs; running locally is fine.
