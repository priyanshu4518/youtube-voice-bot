"""Prompt construction and streamed answer generation.

Latency strategy:
- Stream tokens, so the popup shows text as soon as the model produces it.
- Ask Gemini to think briefly (thinking level "low"); default thinking can add tens of seconds.
  OpenRouter models skip their reasoning step by default for the same reason.
- Fail over fast: one short retry per model, then the next model (no long backoff sleeps).
- Hedge: if Gemini has produced no text after `hedge_after_s`, start OpenRouter too and keep
  whichever answers first. The slower request is cancelled.
"""
import asyncio
import json
import logging
from typing import AsyncIterator

import httpx
from google import genai
from google.genai import errors, types

from app.config import Settings

log = logging.getLogger("app.llm")

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
RETRY_CODES = {429, 500, 503, 504}  # overload / rate limit / transient server errors
RETRY_DELAYS = (0.5,)  # seconds before retrying the same model; then move on to the next one
NO_ANSWER = "No answer was generated."


def fmt_time(t: float) -> str:
    t = int(t)
    h, m, s = t // 3600, t % 3600 // 60, t % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def build_prompt(question: str, chunks: list[dict], current_time: float) -> str:
    context = "\n".join(f"[{fmt_time(c['start'])}] {c['text']}" for c in chunks)
    return (
        "You are an assistant answering questions about a YouTube video using ONLY the transcript "
        f"excerpts below. The viewer is at {fmt_time(current_time)}; you have no knowledge of anything later. "
        "Cite timestamps in the form [m:ss] after the claims they support. If the excerpts do not "
        "contain the answer, say so plainly. Keep the answer concise unless the question asks for detail.\n\n"
        f"Transcript excerpts:\n{context}\n\nQuestion: {question}\nAnswer:"
    )


def is_transient(e: Exception) -> bool:
    if isinstance(e, errors.APIError):
        return e.code in RETRY_CODES
    return isinstance(e, (httpx.TransportError, asyncio.TimeoutError))


async def _first(gen: AsyncIterator[str]) -> str:
    return await gen.__anext__()


async def _close(task: asyncio.Task | None, gen: AsyncIterator[str]) -> None:
    """Cancel a pending first-token wait and close its generator (closes the HTTP stream)."""
    if task is not None and not task.done():
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    await gen.aclose()


class AnswerGenerator:
    def __init__(self, settings: Settings):
        self._s = settings
        self._gemini = genai.Client(
            api_key=settings.gemini_key,
            http_options=types.HttpOptions(timeout=int(settings.gemini_timeout_s * 1000)),
        )
        # One pooled client for the whole app: keep-alive connections skip the TCP + TLS handshake.
        self._http = httpx.AsyncClient(
            timeout=httpx.Timeout(settings.openrouter_timeout_s, connect=10),
            limits=httpx.Limits(max_keepalive_connections=10, keepalive_expiry=120),
        )
        self._plain_models: set[str] = set()  # models that rejected our thinking config

    @property
    def has_backup(self) -> bool:
        return bool(self._s.openrouter_key and self._s.openrouter_models)

    async def aclose(self) -> None:
        await self._http.aclose()
        await self._gemini.aio.aclose()

    # --- public API

    async def stream(self, prompt: str) -> AsyncIterator[str]:
        """Yield answer text as it is generated. Fallbacks only happen before the first token;
        an error after that is raised to the caller. If every provider fails, the Gemini error
        is raised (OpenRouter details are in the log)."""
        primary = self._gemini_stream(prompt)
        backup = self._openrouter_stream(prompt) if self.has_backup else None
        p_task = asyncio.ensure_future(_first(primary))
        b_task = None
        winner = None
        try:
            hedge = self._s.hedge_after_s if backup is not None and self._s.hedge_after_s > 0 else None
            await asyncio.wait({p_task}, timeout=hedge)
            if not p_task.done():
                log.info("Gemini has no text after %.1fs; hedging with OpenRouter", hedge)
                b_task = asyncio.ensure_future(_first(backup))
            first, winner = await self._race(p_task, b_task, primary, backup)
            if winner is None:  # Gemini failed before any text and there was no race yet
                if backup is None:
                    raise p_task.exception()
                log.warning("Gemini failed (%s); falling back to OpenRouter", p_task.exception())
                b_task = asyncio.ensure_future(_first(backup))
                await asyncio.wait({b_task})
                if b_task.exception() is not None:
                    raise p_task.exception()
                first, winner = b_task.result(), backup
            yield first
            async for text in winner:
                yield text
        finally:
            # Cancels the losing request and closes both HTTP streams, also when the client
            # disconnects mid-answer.
            await _close(p_task, primary)
            if backup is not None:
                await _close(b_task, backup)

    async def _race(self, p_task, b_task, primary, backup):
        """Return (first_text, winning_generator), or (None, None) if Gemini failed alone."""
        pending = {t for t in (p_task, b_task) if t is not None}
        while pending:
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for t in done:
                if t.exception() is None:
                    if t is b_task:
                        log.info("OpenRouter answered first")
                    return t.result(), (primary if t is p_task else backup)
                log.warning("%s failed: %s", "Gemini" if t is p_task else "OpenRouter", t.exception())
        if b_task is not None:  # both raced and both failed
            raise p_task.exception()
        return None, None

    # --- Gemini

    def _config(self, model: str) -> types.GenerateContentConfig | None:
        level = self._s.gemini_thinking
        if not level or model in self._plain_models:
            return None
        if "gemini-2" in model:  # 2.x models use a token budget; 0 turns thinking off
            thinking = types.ThinkingConfig(thinking_budget=0)
        else:
            thinking = types.ThinkingConfig(thinking_level=level.upper())
        return types.GenerateContentConfig(thinking_config=thinking)

    async def _gemini_model(self, model: str, prompt: str) -> AsyncIterator[str]:
        while True:
            config = self._config(model)
            started = False
            try:
                stream = await self._gemini.aio.models.generate_content_stream(model=model, contents=prompt, config=config)
                async for chunk in stream:
                    if chunk.text:
                        started = True
                        yield chunk.text
                return
            except errors.ClientError as e:
                # Some models reject some thinking settings with a 400; use the model default instead.
                if started or e.code != 400 or config is None:
                    raise
                log.warning("Gemini %s rejected thinking level %r; using its default", model, self._s.gemini_thinking)
                self._plain_models.add(model)

    async def _gemini_stream(self, prompt: str) -> AsyncIterator[str]:
        """Try each model in order. Transient errors get one quick retry, other errors (e.g. a
        model that doesn't exist) move straight to the next model."""
        failures: list[Exception] = []
        for model in self._s.gen_models:
            for delay in (*RETRY_DELAYS, None):
                started = False
                try:
                    async for text in _strip_leading(self._gemini_model(model, prompt)):
                        started = True
                        yield text
                    if not started:
                        yield NO_ANSWER
                    return
                except Exception as e:
                    if started:
                        raise
                    failures.append(e)
                    retry = delay is not None and is_transient(e)
                    log.warning("Gemini %s failed (%s); %s", model, _short(e), f"retrying in {delay}s" if retry else "next model")
                    if not retry:
                        break
                    await asyncio.sleep(delay)
        # Prefer reporting an overload/rate-limit error: it gives the user the "try again" message.
        raise next((e for e in failures if is_transient(e)), failures[0])

    # --- OpenRouter (OpenAI-compatible streaming chat completions)

    async def _openrouter_model(self, model: str, prompt: str) -> AsyncIterator[str]:
        body = {"model": model, "stream": True, "messages": [{"role": "user", "content": prompt}]}
        reasoning = self._s.openrouter_reasoning
        if reasoning:
            body["reasoning"] = {"enabled": False} if reasoning == "off" else {"effort": reasoning}
        headers = {"Authorization": f"Bearer {self._s.openrouter_key}"}
        async with self._http.stream("POST", OPENROUTER_URL, json=body, headers=headers) as res:
            if res.status_code >= 400:
                await res.aread()
                raise RuntimeError(f"HTTP {res.status_code}: {res.text[:200]}")
            async for line in res.aiter_lines():
                # Lines starting with ":" are keep-alive comments.
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                data = json.loads(line[6:])
                if "error" in data:
                    raise RuntimeError(f"stream error: {data['error']}")
                text = ((data.get("choices") or [{}])[0].get("delta") or {}).get("content")
                if text:
                    yield text

    async def _openrouter_stream(self, prompt: str) -> AsyncIterator[str]:
        last_err: Exception | None = None
        for model in self._s.openrouter_models:
            started = False
            try:
                async for text in _strip_leading(self._openrouter_model(model, prompt)):
                    started = True
                    yield text
                if started:
                    return
                raise ValueError("empty response")
            except Exception as e:
                if started:
                    raise
                last_err = e
                log.warning("OpenRouter %s failed: %s", model, _short(e))
        raise last_err or RuntimeError("No OpenRouter models configured")


async def _strip_leading(gen: AsyncIterator[str]) -> AsyncIterator[str]:
    """Drop leading whitespace (and whitespace-only first chunks) from a token stream."""
    seen_text = False
    async for text in gen:
        if not seen_text:
            text = text.lstrip()
            if not text:
                continue
            seen_text = True
        yield text


def _short(e: Exception) -> str:
    return f"{type(e).__name__}: {str(e)[:160]}"
