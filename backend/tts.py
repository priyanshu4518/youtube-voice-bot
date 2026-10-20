"""Text-to-speech via Cartesia (Sonic)."""
import re

from cartesia import Cartesia

# MP3 keeps responses small and plays natively in the extension's <audio> element.
# Cartesia requires both sample_rate and bit_rate for the mp3 container.
OUTPUT_FORMAT = {"container": "mp3", "sample_rate": 44100, "bit_rate": 128000}
MEDIA_TYPE = "audio/mpeg"

_CITATION = re.compile(r"\s*\[\d+(?::\d{2}){1,2}\]")


def speakable(text: str) -> str:
    """Drop [m:ss] citations so they aren't read aloud, and collapse whitespace."""
    return re.sub(r"\s+", " ", _CITATION.sub("", text)).strip()


def synthesize(client: Cartesia, model: str, voice_id: str, text: str, language: str) -> bytes:
    res = client.tts.generate(
        model_id=model,
        transcript=text,
        voice={"id": voice_id},
        output_format=OUTPUT_FORMAT,
        language=language,
    )
    return res.read()
