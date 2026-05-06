"""JSONL chat memory — stores turns as daily files in ~/.hii/memory/."""

from __future__ import annotations
import json
from pathlib import Path
from dataclasses import dataclass, asdict
from datetime import datetime

MEMORY_DIR = Path.home() / ".hii" / "memory"


@dataclass
class MemoryEntry:
    ts: str
    prompt: str
    answer: str
    tools: list[str]


def _ensure_dir():
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)


def append(entry: MemoryEntry):
    _ensure_dir()
    date = datetime.now().strftime("%Y-%m-%d")
    path = MEMORY_DIR / f"{date}.jsonl"
    with open(path, "a") as f:
        f.write(json.dumps(asdict(entry)) + "\n")


def load_recent(max_entries: int = 30) -> list[MemoryEntry]:
    _ensure_dir()
    files = sorted(MEMORY_DIR.glob("????-??-??.jsonl"), reverse=True)
    entries = []
    for f in files:
        if len(entries) >= max_entries:
            break
        for line in reversed(f.read_text().strip().split("\n")):
            if len(entries) >= max_entries:
                break
            if not line.strip():
                continue
            try:
                entries.append(MemoryEntry(**json.loads(line)))
            except (json.JSONDecodeError, TypeError):
                continue
    return entries


def search(query: str, max_results: int = 20) -> list[MemoryEntry]:
    _ensure_dir()
    q = query.lower()
    results = []
    for f in sorted(MEMORY_DIR.glob("????-??-??.jsonl"), reverse=True):
        if len(results) >= max_results:
            break
        for line in reversed(f.read_text().strip().split("\n")):
            if len(results) >= max_results:
                break
            try:
                entry = MemoryEntry(**json.loads(line))
                if q in entry.prompt.lower() or q in entry.answer.lower():
                    results.append(entry)
            except (json.JSONDecodeError, TypeError):
                continue
    return results


def format_for_context(entries: list[MemoryEntry]) -> str:
    return "\n\n".join(f"[{e.ts}] user: {e.prompt}\nassistant: {e.answer}" for e in entries)


def _estimate_tokens(text: str) -> int:
    """Rough token estimate: ~0.75 words per token."""
    return int(len(text.split()) / 0.75)


def format_compact(entries: list[MemoryEntry], max_tokens: int = 800) -> str:
    """Token-budgeted memory context. Last 3 entries full, older ones compressed."""
    if not entries:
        return ""
    full = entries[:3]
    older = entries[3:]

    parts = []
    budget = max_tokens

    # Recent entries get full content
    for e in full:
        line = f"[{e.ts}] user: {e.prompt}\nassistant: {e.answer}"
        cost = _estimate_tokens(line)
        if budget - cost < 0:
            break
        parts.append(line)
        budget -= cost

    # Older entries get one-line summaries
    for e in older:
        tools = ",".join(e.tools) if e.tools else "chat"
        short_prompt = " ".join(e.prompt.split()[:10])
        line = f"[{e.ts}] {tools}: {short_prompt}..."
        cost = _estimate_tokens(line)
        if budget - cost < 0:
            break
        parts.append(line)
        budget -= cost

    return "\n".join(parts)


def relevance_filter(entries: list[MemoryEntry], query: str, max_entries: int = 10) -> list[MemoryEntry]:
    """Score entries by keyword overlap with query, return top N."""
    if not query.strip():
        return entries[:max_entries]
    q_words = set(query.lower().split())

    def score(e: MemoryEntry) -> int:
        text_words = set(f"{e.prompt} {e.answer}".lower().split())
        return len(q_words & text_words)

    scored = sorted(entries, key=score, reverse=True)
    return scored[:max_entries]
