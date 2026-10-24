"""Application factory: builds the shared services once and wires up middleware and routes."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool

from app.api import Services, router
from app.config import load_settings
from app.core.timing import TimingMiddleware
from app.services.llm import AnswerGenerator
from app.services.retrieval import Embedder, IndexStore
from app.services.transcript import fetch_transcript
from app.services.tts import SpeechService

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
log = logging.getLogger("app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = load_settings()
    embedder = Embedder()
    # Load + warm up the embedding model before serving, so no request pays for it.
    await run_in_threadpool(embedder.load)
    svc = Services(
        settings=settings,
        embedder=embedder,
        indexes=IndexStore(embedder, fetch_transcript, settings.cache_dir, settings.index_cache_size),
        llm=AnswerGenerator(settings) if settings.gemini_key else None,
        tts=SpeechService(settings) if settings.cartesia_key else None,
    )
    app.state.services = svc
    log.info("Ready. Gemini models: %s; hedge after %ss", settings.gen_models, settings.hedge_after_s)
    yield
    # Close pooled HTTP connections cleanly on shutdown.
    if svc.llm:
        await svc.llm.aclose()
    if svc.tts:
        await svc.tts.aclose()


def create_app() -> FastAPI:
    app = FastAPI(title="YouTube AI Assistant", lifespan=lifespan)
    # Extension origins are chrome-extension://<id>; allowed broadly since this is a local-only server.
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
                       expose_headers=["Server-Timing"])
    app.add_middleware(TimingMiddleware)  # added last = outermost, so it times everything
    app.include_router(router)
    return app
