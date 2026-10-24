"""All settings in one place, read once from backend/.env at startup."""
import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND_DIR / ".env")


def _str(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _csv(name: str, default: str) -> list[str]:
    return [m.strip() for m in os.getenv(name, default).split(",") if m.strip()]


def _num(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    # Gemini: main model first, then fallbacks (tried when one is overloaded, rate limited or missing).
    gemini_key: str | None
    gen_models: list[str]
    # "low" asks the model to think briefly (much faster first token). Empty = model default.
    gemini_thinking: str
    gemini_timeout_s: float
    # OpenRouter: used when Gemini fails, and raced against Gemini when Gemini is slow (hedging).
    openrouter_key: str | None
    openrouter_models: list[str]
    # "off" skips the model's hidden reasoning step (first token ~3x sooner); "low"/"medium"/"high"
    # set a reasoning effort; empty = model default.
    openrouter_reasoning: str
    openrouter_timeout_s: float
    # Start the OpenRouter request if Gemini has produced no text after this many seconds. 0 = never.
    hedge_after_s: float
    # Cartesia text-to-speech.
    cartesia_key: str | None
    tts_model: str
    tts_voice: str
    tts_language: str
    tts_timeout_s: float
    tts_cache_mb: float
    # Retrieval and caching.
    top_k: int
    index_cache_size: int
    cache_dir: Path


def load_settings() -> Settings:
    gen_model = _str("GEMINI_MODEL", "gemini-2.5-flash")
    fallbacks = _csv("GEMINI_FALLBACK_MODELS", "gemini-2.5-flash")
    return Settings(
        gemini_key=_str("GEMINI_API_KEY") or None,
        gen_models=list(dict.fromkeys([gen_model, *fallbacks])),
        gemini_thinking=_str("GEMINI_THINKING_LEVEL", "low").lower(),
        gemini_timeout_s=_num("GEMINI_TIMEOUT_S", 60),
        openrouter_key=_str("OPENROUTER_API_KEY") or None,
        openrouter_models=_csv(
            "OPENROUTER_MODELS", "nvidia/nemotron-3-ultra-550b-a55b:free,thinkingmachines/inkling:free"
        ),
        openrouter_reasoning=_str("OPENROUTER_REASONING", "off").lower(),
        openrouter_timeout_s=_num("OPENROUTER_TIMEOUT_S", 60),
        hedge_after_s=_num("LLM_HEDGE_AFTER_S", 4),
        cartesia_key=_str("CARTESIA_API_KEY") or None,
        tts_model=_str("CARTESIA_MODEL", "sonic-3.6"),
        tts_voice=_str("CARTESIA_VOICE_ID", "e07c00bc-4134-4eae-9ea4-1a55fb45746b"),
        tts_language=_str("CARTESIA_LANGUAGE", "en"),
        tts_timeout_s=_num("CARTESIA_TIMEOUT_S", 30),
        tts_cache_mb=_num("TTS_CACHE_MB", 64),
        top_k=int(_num("RETRIEVAL_TOP_K", 5)),
        index_cache_size=int(_num("INDEX_CACHE_SIZE", 64)),
        cache_dir=Path(_str("CACHE_DIR") or BACKEND_DIR / "cache"),
    )
