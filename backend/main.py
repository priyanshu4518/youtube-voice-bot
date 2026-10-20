"""FastAPI app. Run: uvicorn main:app --reload --port 8000"""
import os

import cartesia
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from pydantic import BaseModel, Field

import gemini
import retrieval
import tts
from transcript import TranscriptError, fetch_transcript

load_dotenv()
API_KEY = os.getenv("GEMINI_API_KEY")
GEN_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
client = genai.Client(api_key=API_KEY) if API_KEY else None

CARTESIA_KEY = os.getenv("CARTESIA_API_KEY")
TTS_MODEL = os.getenv("CARTESIA_MODEL", "sonic-3.6")
TTS_VOICE = os.getenv("CARTESIA_VOICE_ID", "e07c00bc-4134-4eae-9ea4-1a55fb45746b")
TTS_LANGUAGE = os.getenv("CARTESIA_LANGUAGE", "en")
tts_client = cartesia.Cartesia(api_key=CARTESIA_KEY, timeout=30) if CARTESIA_KEY else None

app = FastAPI(title="YouTube AI Assistant")
# Extension origins are chrome-extension://<id>; allowed broadly since this is a local-only server.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class TranscriptReq(BaseModel):
    video_id: str


class AskReq(BaseModel):
    video_id: str
    question: str = Field(min_length=1)
    current_time: float = Field(ge=0)


class SpeakReq(BaseModel):
    text: str = Field(max_length=5000)


def _load(video_id: str) -> list[dict]:
    if client is None:
        raise HTTPException(500, "GEMINI_API_KEY is not set in backend/.env")
    try:
        return retrieval.get_chunks(video_id, fetch_transcript)
    except TranscriptError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(502, f"Indexing failed: {e}")


@app.post("/transcript")
def transcript(req: TranscriptReq):
    chunks = _load(req.video_id)
    return {
        "video_id": req.video_id,
        "chunks": [{"start": c["start"], "end": c["end"], "text": c["text"]} for c in chunks],
    }


@app.post("/ask")
def ask(req: AskReq):
    _load(req.video_id)
    try:
        hits = retrieval.search(req.video_id, req.question, req.current_time)
        if not hits:
            return {"answer": "Nothing has been said yet at this point in the video.", "sources": []}
        answer = gemini.generate_answer(client, GEN_MODEL, req.question, hits, req.current_time)
    except Exception as e:
        raise HTTPException(502, f"Gemini request failed: {e}")
    return {"answer": answer, "sources": [{"start": h["start"], "text": h["text"]} for h in hits]}


@app.post("/speak")
def speak(req: SpeakReq):
    """Turn an answer into speech. Returns MP3 bytes; errors are JSON like the other endpoints."""
    if tts_client is None:
        raise HTTPException(500, "CARTESIA_API_KEY is not set in backend/.env")
    text = tts.speakable(req.text) 
    # text = text[:100] if len(text) > 100 else text 
    if not text:
        raise HTTPException(400, "There is no answer text to speak.")
    try:
        audio = tts.synthesize(tts_client, TTS_MODEL, TTS_VOICE, text, TTS_LANGUAGE)
    except cartesia.AuthenticationError:
        raise HTTPException(502, "Cartesia rejected the API key. Check CARTESIA_API_KEY in backend/.env")
    except cartesia.RateLimitError:
        raise HTTPException(429, "Cartesia rate limit reached. Try again in a moment.")
    except cartesia.APIStatusError as e:
        raise HTTPException(502, f"Cartesia request failed ({e.status_code}): {e.message}")
    except cartesia.APIConnectionError as e:
        raise HTTPException(504 if isinstance(e, cartesia.APITimeoutError) else 502, f"Cannot reach Cartesia: {e}")
    if not audio:
        raise HTTPException(502, "Cartesia returned no audio.")
    return Response(content=audio, media_type=tts.MEDIA_TYPE)
