"""Claude Code CLI backend."""

from __future__ import annotations
import subprocess
from .base import ChatMessage


class ClaudeClient:
    def chat(self, model: str, messages: list[ChatMessage], temperature: float = 0.2) -> str:
        prompt = "\n\n".join(f"{m.role.upper()}:\n{m.content}" for m in messages)
        result = subprocess.run(
            ["claude", "-p", "--model", model, prompt],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Claude error: {result.stderr.strip()}")
        return result.stdout.strip()

    def embed(self, model: str, texts: list[str]) -> list[list[float]]:
        raise NotImplementedError("Claude does not support embeddings")
