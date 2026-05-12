"""Local JSONL scan event trace at ~/.hii/traces/capabilities.jsonl."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

TRACE_PATH = Path.home() / ".hii" / "traces" / "capabilities.jsonl"


def emit(
    scan_id: str,
    event_type: str,
    *,
    scanner: str = "",
    status: str = "",
    duration_ms: float = 0.0,
    detected_count: int = 0,
    warnings: list[str] | None = None,
    errors: list[str] | None = None,
    **extra: Any,
) -> None:
    """Append a single JSONL event. Never raises — tracing must not break a scan."""
    try:
        TRACE_PATH.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "ts": time.time(),
            "scan_id": scan_id,
            "event_type": event_type,
            "scanner": scanner,
            "status": status,
            "duration_ms": round(duration_ms, 2),
            "detected_count": detected_count,
            "warnings": warnings or [],
            "errors": errors or [],
        }
        if extra:
            entry.update(extra)
        with TRACE_PATH.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, default=str) + "\n")
    except Exception:
        pass  # tracing is best-effort; never propagate
