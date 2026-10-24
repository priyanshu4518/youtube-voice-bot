"""Text-to-speech via Cartesia (Sonic).

Audio is streamed: bytes are forwarded to the client as Cartesia produces them, so playback can
start before the whole clip is synthesized. Finished clips are kept in an LRU cache, so replaying
the same answer is instant and costs no Cartesia credits.
"""
import hashlib
import re
from typing import AsyncIterator

from cartesia import AsyncCartesia

from app.config import Settings
from app.core.cache import LRUCache

# MP3 keeps responses small and plays natively in the extension's <audio> element.
# Cartesia requires both sample_rate and bit_rate for the mp3 container.
OUTPUT_FORMAT = {"container": "mp3", "sample_rate": 44100, "bit_rate": 128000}
MEDIA_TYPE = "audio/mpeg"

_CITATION = re.compile(r"\s*\[\d+(?::\d{2}){1,2}\]")


def speakable(text: str) -> str:
    """Drop [m:ss] citations so they aren't read aloud, and collapse whitespace."""
    return re.sub(r"\s+", " ", _CITATION.sub("", text)).strip()


class SpeechService:
    def __init__(self, settings: Settings):
        self._s = settings
        self._client = AsyncCartesia(api_key=settings.cartesia_key, timeout=settings.tts_timeout_s)
        self._cache = LRUCache(max_weight=settings.tts_cache_mb * 1024 * 1024, weigh=len)

    def __len__(self) -> int:
        return len(self._cache)

    async def aclose(self) -> None:
        await self._client.close()

    def _key(self, text: str) -> str:
        s = self._s
        return hashlib.sha256(f"{s.tts_model}|{s.tts_voice}|{s.tts_language}|{text}".encode()).hexdigest()

    async def stream(self, text: str) -> AsyncIterator[bytes]:
        """Yield MP3 bytes. Cartesia errors are raised on the first iteration, before any audio."""
        key = self._key(text)
        cached = self._cache.get(key)
        if cached is not None:
            yield cached
            return
        buf = bytearray()
        async with self._client.tts.with_streaming_response.generate(
            model_id=self._s.tts_model,
            transcript=text,
            voice={"id": self._s.tts_voice},
            output_format=OUTPUT_FORMAT,
            language=self._s.tts_language,
        ) as res:
            async for chunk in res.iter_bytes():
                if chunk:
                    buf += chunk
                    yield chunk
        if buf:  # only complete clips are cached (an interrupted stream never gets here)
            self._cache.put(key, bytes(buf))
