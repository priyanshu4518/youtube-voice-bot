"""Prompt construction and answer generation."""
from google import genai


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


def generate_answer(client: genai.Client, model: str, question: str, chunks: list[dict], current_time: float) -> str:
    res = client.models.generate_content(model=model, contents=build_prompt(question, chunks, current_time))
    return (res.text or "").strip() or "No answer was generated."
