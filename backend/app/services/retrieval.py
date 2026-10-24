"""Chunking, local embeddings (all-MiniLM-L6-v2), timestamp filtering and similarity search.

A video's index (chunks + embedding vectors) is looked up in three tiers:
  1. in-memory LRU            ~microseconds
  2. on-disk cache (cache/)   a few ms; survives server restarts
  3. build                    fetch transcript from YouTube + embed every chunk (seconds)
Concurrent requests for the same video share one build (single-flight), and the embedding
step runs in the background so /transcript can answer before it finishes.
"""
import asyncio
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Callable

import numpy as np
from sentence_transformers import SentenceTransformer
from starlette.concurrency import run_in_threadpool

from app.config import BACKEND_DIR
from app.core.cache import LRUCache, SingleFlight
from app.core.timing import stage

log = logging.getLogger("app.retrieval")

CHUNK_SECONDS = 30.0
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
# Weights are downloaded once into this folder, then always loaded from disk (no network).
MODEL_DIR = BACKEND_DIR / "models" / "all-MiniLM-L6-v2"
# Bump when the chunking or the stored format changes, so stale disk entries are rebuilt.
INDEX_VERSION = 1
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


class Embedder:
    """Wraps the sentence-transformer. `embed` and `query` are CPU-bound: call them in a thread."""

    def __init__(self):
        self._model: SentenceTransformer | None = None
        # Repeated questions (same wording) skip the model entirely.
        self.query = lru_cache(maxsize=1024)(self._query)

    def load(self) -> None:
        if MODEL_DIR.exists():
            model = SentenceTransformer(str(MODEL_DIR), local_files_only=True)
        else:
            model = SentenceTransformer(MODEL_NAME)
            model.save(str(MODEL_DIR))
        # The first encode() is several times slower than later ones (lazy allocations and
        # kernel selection). Pay that at startup instead of on the first user request.
        model.encode(["warm up"], normalize_embeddings=True)
        self._model = model

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def embed(self, texts: list[str]) -> np.ndarray:
        vectors = self._model.encode(texts, normalize_embeddings=True, batch_size=64, convert_to_numpy=True)
        return vectors.astype(np.float32, copy=False)

    def _query(self, text: str) -> np.ndarray:
        v = self.embed([text])[0]
        v.setflags(write=False)  # shared through the cache, so make it immutable
        return v


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


@dataclass(frozen=True)
class VideoIndex:
    chunks: list[dict]
    vectors: np.ndarray  # (n, 384) float32, L2-normalized, so a dot product is cosine similarity
    starts: np.ndarray  # (n,) chunk start times in ascending order

    @classmethod
    def build(cls, chunks: list[dict], vectors: np.ndarray) -> "VideoIndex":
        return cls(chunks, vectors, np.array([c["start"] for c in chunks], dtype=np.float64))

    def search(self, q: np.ndarray, current_time: float, k: int) -> list[dict]:
        """Filter by timestamp FIRST, then rank only the eligible chunks."""
        # Chunks are sorted by start, so the eligible ones are a prefix: binary search, no copy.
        n = int(np.searchsorted(self.starts, current_time, side="right"))
        if n == 0:
            return []
        scores = self.vectors[:n] @ q
        # O(n) partial selection of the top k instead of sorting every score.
        top = np.argpartition(-scores, k - 1)[:k] if n > k else np.arange(n)
        results = []
        for i in np.sort(top):  # ascending index == chronological order
            c = self.chunks[i]
            # Trim the boundary chunk so text after the playback position never reaches the LLM.
            segs = [s for s in c["segments"] if s["start"] <= current_time]
            results.append({"start": c["start"], "text": " ".join(s["text"] for s in segs), "score": float(scores[i])})
        return results


class IndexStore:
    """Building a new video's index is split in two so the slow part overlaps with the user typing:
    `chunks()` returns once the transcript is fetched and chunked (enough for /transcript), while
    embedding continues in the background. `get()` (used by /ask) waits for that same build."""

    def __init__(self, embedder: Embedder, fetch: Callable[[str], list[dict]], cache_dir: Path, max_items: int):
        self._embedder = embedder
        self._fetch = fetch
        self._dir = cache_dir
        self._mem = LRUCache(max_items=max_items)
        self._flight = SingleFlight()
        # video_id -> (chunks, embedding task) while an index is being built
        self._building: dict[str, tuple[list[dict], asyncio.Task]] = {}
        self._bg: set[asyncio.Task] = set()  # keeps background disk writes alive until they finish

    def __len__(self) -> int:
        return len(self._mem)

    async def chunks(self, video_id: str) -> list[dict]:
        index = self._mem.get(video_id)
        if index is not None:
            return index.chunks
        if video_id in self._building:
            return self._building[video_id][0]
        return await self._flight.do(video_id, lambda: self._prepare(video_id))

    async def get(self, video_id: str) -> VideoIndex:
        index = self._mem.get(video_id)
        if index is not None:
            return index
        if video_id not in self._building:
            await self.chunks(video_id)  # loads from disk, or starts a build
            index = self._mem.get(video_id)
            if index is not None:
                return index
        entry = self._building[video_id]
        try:
            with stage("embed_wait"):
                return await asyncio.shield(entry[1])
        except Exception:
            if self._building.get(video_id) is entry:
                del self._building[video_id]  # let the next request retry from scratch
            raise

    async def _prepare(self, video_id: str) -> list[dict]:
        with stage("index_disk"):
            index = await run_in_threadpool(self._read_disk, video_id)
        if index is not None:
            self._mem.put(video_id, index)
            return index.chunks
        with stage("transcript_fetch"):
            segments = await run_in_threadpool(self._fetch, video_id)
        segments.sort(key=lambda s: s["start"])
        chunks = chunk_segments(segments)
        task = asyncio.create_task(self._embed(video_id, chunks))
        task.add_done_callback(lambda t: t.cancelled() or t.exception())  # failures surface via get()
        self._building[video_id] = (chunks, task)
        return chunks

    async def _embed(self, video_id: str, chunks: list[dict]) -> VideoIndex:
        t0 = time.perf_counter()
        vectors = await run_in_threadpool(self._embedder.embed, [c["text"] for c in chunks])
        log.info("Embedded %d chunks of %s in %.0f ms", len(chunks), video_id, (time.perf_counter() - t0) * 1000)
        index = VideoIndex.build(chunks, vectors)
        self._mem.put(video_id, index)
        self._building.pop(video_id, None)
        # Persist off the request path; nobody waits for the disk.
        task = asyncio.create_task(run_in_threadpool(self._write_disk, video_id, index))
        self._bg.add(task)
        task.add_done_callback(self._bg.discard)
        return index

    # --- disk tier: <video_id>.npy (vectors) + <video_id>.json (chunks; written last = commit marker)

    def _paths(self, video_id: str) -> tuple[Path, Path]:
        if not VIDEO_ID.match(video_id):  # never build file paths from unchecked input
            raise ValueError(f"Invalid video id: {video_id!r}")
        return self._dir / f"{video_id}.json", self._dir / f"{video_id}.npy"

    def _meta(self) -> dict:
        return {"version": INDEX_VERSION, "model": MODEL_NAME, "window": CHUNK_SECONDS}

    def _read_disk(self, video_id: str) -> VideoIndex | None:
        meta_path, vec_path = self._paths(video_id)
        if not meta_path.exists():
            return None
        try:
            data = json.loads(meta_path.read_text(encoding="utf-8"))
            if data.get("meta") != self._meta():
                return None
            vectors = np.load(vec_path)
            if vectors.shape[0] != len(data["chunks"]):
                return None
            return VideoIndex.build(data["chunks"], vectors)
        except Exception as e:
            log.warning("Ignoring unreadable cache entry for %s: %s", video_id, e)
            return None

    def _write_disk(self, video_id: str, index: VideoIndex) -> None:
        meta_path, vec_path = self._paths(video_id)
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
            # Write to temp files and rename: a crash mid-write never leaves a half-written entry.
            with open(f"{vec_path}.tmp", "wb") as f:
                np.save(f, index.vectors)
            os.replace(f"{vec_path}.tmp", vec_path)
            payload = json.dumps({"meta": self._meta(), "chunks": index.chunks}, ensure_ascii=False)
            Path(f"{meta_path}.tmp").write_text(payload, encoding="utf-8")
            os.replace(f"{meta_path}.tmp", meta_path)
        except Exception as e:
            log.warning("Could not write cache entry for %s: %s", video_id, e)
