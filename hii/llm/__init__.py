"""LLM backend management."""

from __future__ import annotations
from .base import ChatMessage, ChatBackend
from .ollama import OllamaClient
from .claude import ClaudeClient


def get_client(backend: str, **kwargs) -> ChatBackend:
    if backend == "ollama":
        return OllamaClient(kwargs.get("url", "http://127.0.0.1:11434"))
    elif backend == "claude":
        return ClaudeClient()
    else:
        return OllamaClient()


__all__ = ["ChatMessage", "ChatBackend", "get_client", "OllamaClient", "ClaudeClient"]
