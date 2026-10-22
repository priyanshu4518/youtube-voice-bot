"""Prompt construction and answer generation."""
import time

import httpx
from google import genai
from google.genai import errors


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
        "contain the answer, say so plainly.\n\n"
        f"Transcript excerpts:\n{context}\n\nQuestion: {question}\nAnswer:"
    )


OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
RETRY_CODES = {429, 500, 503, 504}  # overload / rate limit / transient server errors
RETRY_DELAYS = (1, 2, 4)  # seconds between attempts on the same model


def _gemini_answer(client: genai.Client, models: list[str], prompt: str) -> str:
    """Try each Gemini model in order, retrying transient errors with backoff before moving on."""
    last_err = None
    for model in models:
        for delay in (*RETRY_DELAYS, None):
            try:
                res = client.models.generate_content(model=model, contents=prompt)
                return (res.text or "").strip() or "No answer was generated."
            except errors.APIError as e:
                if e.code not in RETRY_CODES:
                    raise
                last_err = e
                print(f"Gemini {model} returned {e.code}; " + (f"retrying in {delay}s" if delay is not None else "giving up on this model"))
                if delay is not None:
                    time.sleep(delay)
    raise last_err


def _openrouter_answer(api_key: str, models: list[str], prompt: str) -> str:
    """Try each OpenRouter model in order (OpenAI-compatible chat completions API)."""
    last_err = None
    for model in models:
        try:
            res = httpx.post(
                OPENROUTER_URL,
                headers={"Authorization": f"Bearer {api_key}"},
                json={"model": model, "messages": [{"role": "user", "content": prompt}]},
                timeout=60,
            )
            res.raise_for_status()
            text = (res.json()["choices"][0]["message"].get("content") or "").strip()
            if not text:
                raise ValueError("empty response")
            return text
        except Exception as e:
            last_err = e
            print(f"OpenRouter {model} failed: {e}")
    raise last_err


def generate_answer(
    client: genai.Client,
    models: list[str],
    question: str,
    chunks: list[dict],
    current_time: float,
    openrouter_key: str | None = None,
    openrouter_models: list[str] = (),
) -> str:
    """Answer with Gemini; if Gemini fails for any reason, fall back to OpenRouter (when configured)."""
    prompt = build_prompt(question, chunks, current_time)
    try:
        return _gemini_answer(client, models, prompt)
    except Exception as gemini_err:
        if not (openrouter_key and openrouter_models):
            raise
        print(f"Gemini failed ({gemini_err}); falling back to OpenRouter")
        try:
            return _openrouter_answer(openrouter_key, list(openrouter_models), prompt)
        except Exception:
            raise gemini_err  # report the primary failure; OpenRouter details are in the log
