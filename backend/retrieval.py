"""Chunking, local embeddings (all-MiniLM-L6-v2), timestamp filtering and similarity search."""
import numpy as np
from sentence_transformers import SentenceTransformer

CHUNK_SECONDS = 30.0
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
_cache: dict[str, dict] = {}  # video_id -> {"chunks": [...], "vectors": np.ndarray}
_model: SentenceTransformer | None = None


def _get_model() -> SentenceTransformer:
    global _model
    if _model is None:
        _model = SentenceTransformer(MODEL_NAME)
    return _model


def _embed(texts: list[str]) -> np.ndarray:
    return _get_model().encode(texts, normalize_embeddings=True)


def chunk_segments(segments: list[dict], window: float = CHUNK_SECONDS) -> list[dict]:
    """Group consecutive segments into ~window-second chunks. Each chunk keeps its segments
    so the boundary chunk can be trimmed to the playback position later."""
    groups, cur = [], []
    for seg in segments:
        if cur and seg["start"] - cur[0]["start"] >= window:
            groups.append(cur)
            cur = []
        cur.append(seg)
    if cur:
        groups.append(cur)
    return [
        {
            "start": g[0]["start"],
            "end": g[-1]["start"] + g[-1]["duration"],
            "text": " ".join(s["text"] for s in g),
            "segments": g,
        }
        for g in groups
    ]


def get_chunks(video_id: str, fetch) -> list[dict]:
    """Return cached chunks, or fetch + chunk + embed on first use."""
    if video_id not in _cache:
        chunks = chunk_segments(fetch(video_id))
        _cache[video_id] = {"chunks": chunks, "vectors": _embed([c["text"] for c in chunks])}
    return _cache[video_id]["chunks"]


def search(video_id: str, question: str, current_time: float, k: int = 5) -> list[dict]:
    """Filter by timestamp FIRST, then rank only the eligible chunks."""
    entry = _cache[video_id]
    eligible = [i for i, c in enumerate(entry["chunks"]) if c["start"] <= current_time]
    if not eligible:
        return []
    q = _embed([question])[0]
    scores = entry["vectors"][eligible] @ q
    top = np.argsort(-scores)[:k]
    results = []
    for j in sorted(top, key=lambda j: entry["chunks"][eligible[j]]["start"]):
        c = entry["chunks"][eligible[j]]
        # Trim the boundary chunk so text after the playback position never reaches the LLM.
        segs = [s for s in c["segments"] if s["start"] <= current_time]
        results.append({"start": c["start"], "text": " ".join(s["text"] for s in segs), "score": float(scores[j])})
    return results
