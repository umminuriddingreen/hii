"""Chat backend protocol."""

from __future__ import annotations
from typing import Protocol
from dataclasses import dataclass


@dataclass
class ChatMessage:
    role: str  # system | user | assistant | tool
    content: str


class ChatBackend(Protocol):
    def chat(self, model: str, messages: list[ChatMessage], temperature: float = 0.2) -> str: ...
    def embed(self, model: str, texts: list[str]) -> list[list[float]]: ...
