"""HTTP routes. Handlers validate input, call services and map failures to HTTP errors;
all the work lives in app/services."""
import json
import logging
import time
from dataclasses import dataclass
from typing import AsyncIterator

import cartesia
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from google.genai import errors as genai_errors
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from app.config import Settings
from app.core.timing import record, stage
from app.services import llm, tts
from app.services.llm import AnswerGenerator
from app.services.retrieval import Embedder, IndexStore, VideoIndex
from app.services.transcript import TranscriptError
from app.services.tts import SpeechService

log = logging.getLogger("app.api")

# YouTube video ids are 11 characters. Checking this also keeps ids safe to use in cache file names.
VIDEO_ID_PATTERN = r"^[A-Za-z0-9_-]{11}$"
NOTHING_YET = "Nothing has been said yet at this point in the video."


class TranscriptReq(BaseModel):
    video_id: str = Field(pattern=VIDEO_ID_PATTERN)


class AskReq(BaseModel):
    video_id: str = Field(pattern=VIDEO_ID_PATTERN)
    question: str = Field(min_length=1)
    current_time: float = Field(ge=0)


class SpeakReq(BaseModel):
    text: str = Field(max_length=5000)


@dataclass
class Services:
    """Long-lived objects created once at startup (see app/__init__.py) and shared by all requests."""

    settings: Settings
    embedder: Embedder
    indexes: IndexStore
    llm: AnswerGenerator | None
    tts: SpeechService | None


def services(request: Request) -> Services:
    return request.app.state.services


router = APIRouter()


async def _index(svc: Services, video_id: str, chunks_only: bool = False) -> VideoIndex | list[dict]:
    if svc.llm is None:
        raise HTTPException(500, "GEMINI_API_KEY is not set in backend/.env")
    try:
        with stage("index"):
            if chunks_only:
                return await svc.indexes.chunks(video_id)
            return await svc.indexes.get(video_id)
    except TranscriptError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(502, f"Indexing failed: {e}")


async def _retrieve(svc: Services, req: AskReq) -> list[dict]:
    index = await _index(svc, req.video_id)
    with stage("retrieve"):
        q = await run_in_threadpool(svc.embedder.query, req.question)
        return index.search(q, req.current_time, svc.settings.top_k)


def _llm_error(e: Exception) -> HTTPException:
    if llm.is_transient(e) and isinstance(e, genai_errors.APIError):
        return HTTPException(503, "Gemini is busy right now (high demand). Please try again in a minute.")
    return HTTPException(502, f"Gemini request failed: {e}")


async def _start_answer(svc: Services, req: AskReq, hits: list[dict]) -> tuple[str, AsyncIterator[str]]:
    """Start generating and wait for the first text, so a failure can still become an HTTP error."""
    t0 = time.perf_counter()
    gen = svc.llm.stream(llm.build_prompt(req.question, hits, req.current_time))
    try:
        first = await gen.__anext__()
    except Exception as e:
        await gen.aclose()
        raise _llm_error(e)
    record("llm_first_token", (time.perf_counter() - t0) * 1000)
    return first, gen


def _sources(hits: list[dict]) -> list[dict]:
    return [{"start": h["start"], "text": h["text"]} for h in hits]


@router.post("/transcript")
async def transcript(req: TranscriptReq, svc: Services = Depends(services)):
    """Returns as soon as the transcript is chunked; embedding finishes in the background
    (usually while the user is still typing). /ask waits for it if needed."""
    chunks = await _index(svc, req.video_id, chunks_only=True)
    # JSONResponse skips FastAPI's generic jsonable_encoder pass, which walks every value of
    # this (potentially large) payload; the data is already plain JSON types.
    return JSONResponse({
        "video_id": req.video_id,
        "chunks": [{"start": c["start"], "end": c["end"], "text": c["text"]} for c in chunks],
    })


@router.post("/ask")
async def ask(req: AskReq, svc: Services = Depends(services)):
    """Whole answer in one JSON response. The popup uses /ask/stream instead."""
    hits = await _retrieve(svc, req)
    if not hits:
        return {"answer": NOTHING_YET, "sources": []}
    first, gen = await _start_answer(svc, req, hits)
    parts = [first]
    try:
        async for text in gen:
            parts.append(text)
    except Exception as e:
        raise _llm_error(e)
    finally:
        await gen.aclose()
    return {"answer": "".join(parts).strip(), "sources": _sources(hits)}


def _line(event: dict) -> bytes:
    return (json.dumps(event, ensure_ascii=False) + "\n").encode()


@router.post("/ask/stream")
async def ask_stream(req: AskReq, svc: Services = Depends(services)):
    """Stream the answer as newline-delimited JSON events:
    {"type":"sources","sources":[...]}, then {"type":"delta","text":"..."} as text is generated,
    then {"type":"done"} or {"type":"error","detail":"..."}.
    Errors before the first text (missing key, no transcript, every model failing) are normal
    HTTP errors with a JSON {"detail"}, exactly like /ask."""
    hits = await _retrieve(svc, req)
    first, gen = (NOTHING_YET, None) if not hits else await _start_answer(svc, req, hits)

    async def events():
        t0 = time.perf_counter()
        try:
            yield _line({"type": "sources", "sources": _sources(hits)})
            yield _line({"type": "delta", "text": first})
            if gen is not None:
                async for text in gen:
                    yield _line({"type": "delta", "text": text})
            yield _line({"type": "done"})
        except Exception as e:
            log.warning("Answer stream failed midway: %s", e)
            yield _line({"type": "error", "detail": _llm_error(e).detail})
        finally:
            if gen is not None:
                await gen.aclose()
            record("llm_stream", (time.perf_counter() - t0) * 1000)

    return StreamingResponse(
        events(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/speak")
async def speak(req: SpeakReq, svc: Services = Depends(services)):
    """Turn an answer into speech. Streams MP3 bytes; errors are JSON like the other endpoints."""
    if svc.tts is None:
        raise HTTPException(500, "CARTESIA_API_KEY is not set in backend/.env")
    text = tts.speakable(req.text)
    if not text:
        raise HTTPException(400, "There is no answer text to speak.")
    audio = svc.tts.stream(text)
    try:
        with stage("tts_first_byte"):
            first = await audio.__anext__()
    except StopAsyncIteration:
        raise HTTPException(502, "Cartesia returned no audio.")
    except cartesia.AuthenticationError:
        raise HTTPException(502, "Cartesia rejected the API key. Check CARTESIA_API_KEY in backend/.env")
    except cartesia.RateLimitError:
        raise HTTPException(429, "Cartesia rate limit reached. Try again in a moment.")
    except cartesia.APIStatusError as e:
        raise HTTPException(502, f"Cartesia request failed ({e.status_code}): {e.message}")
    except cartesia.APIConnectionError as e:
        raise HTTPException(504 if isinstance(e, cartesia.APITimeoutError) else 502, f"Cannot reach Cartesia: {e}")

    async def body():
        try:
            yield first
            async for chunk in audio:
                yield chunk
        finally:
            await audio.aclose()

    return StreamingResponse(body(), media_type=tts.MEDIA_TYPE)


@router.get("/health")
async def health(svc: Services = Depends(services)):
    return {
        "status": "ok",
        "embedding_model_loaded": svc.embedder.loaded,
        "videos_in_memory": len(svc.indexes),
        "tts_clips_cached": len(svc.tts) if svc.tts else 0,
        "gemini_configured": svc.llm is not None,
        "openrouter_configured": bool(svc.llm and svc.llm.has_backup),
        "tts_configured": svc.tts is not None,
    }
