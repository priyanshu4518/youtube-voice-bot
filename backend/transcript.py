"""Transcript retrieval. Adapted from ../test.py (youtube-transcript-api).

To swap in a different transcript source, only change `fetch_transcript`;
it must return a list of {"text": str, "start": float, "duration": float}.
"""
from youtube_transcript_api import YouTubeTranscriptApi


class TranscriptError(Exception):
    pass


def fetch_transcript(video_id: str) -> list[dict]:
    try:
        fetched = YouTubeTranscriptApi().fetch(video_id)
    except Exception as e:  # the library raises many specific exception types
        raise TranscriptError(f"Could not fetch transcript for '{video_id}': {e}") from e
    segments = [
        {"text": s.text.replace("\n", " ").strip(), "start": float(s.start), "duration": float(s.duration)}
        for s in fetched
        if s.text.strip()
    ]
    if not segments:
        raise TranscriptError("Transcript is empty.")
    return segments
