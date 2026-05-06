"""Ollama HTTP client."""

from __future__ import annotations
import httpx
from .base import ChatMessage

DEFAULT_URL = "http://127.0.0.1:11434"
TIMEOUT = 120.0


class OllamaClient:
    def __init__(self, url: str = DEFAULT_URL):
        self.url = url.rstrip("/")

    def chat(self, model: str, messages: list[ChatMessage], temperature: float = 0.2) -> str:
        payload = {
            "model": model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": False,
            "options": {"temperature": temperature},
        }
        r = httpx.post(f"{self.url}/api/chat", json=payload, timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json()
        return data.get("message", {}).get("content", "")

    def embed(self, model: str, texts: list[str]) -> list[list[float]]:
        r = httpx.post(
            f"{self.url}/api/embeddings",
            json={"model": model, "input": texts},
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        return r.json().get("embeddings", [])

    def models(self) -> list[str]:
        r = httpx.get(f"{self.url}/api/tags", timeout=10)
        r.raise_for_status()
        return [m["name"] for m in r.json().get("models", [])]
