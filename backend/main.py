"""FastAPI app. Run: uvicorn main:app --reload --port 8000"""
import os

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from pydantic import BaseModel, Field

import gemini
import retrieval
from transcript import TranscriptError, fetch_transcript

load_dotenv()
API_KEY = os.getenv("GEMINI_API_KEY")
GEN_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
client = genai.Client(api_key=API_KEY) if API_KEY else None

app = FastAPI(title="YouTube AI Assistant")
# Extension origins are chrome-extension://<id>; allowed broadly since this is a local-only server.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class TranscriptReq(BaseModel):
    video_id: str


class AskReq(BaseModel):
    video_id: str
    question: str = Field(min_length=1)
    current_time: float = Field(ge=0)


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
