"""Capability map persistence with previous + last_good rotation.

Layout in ~/.hii/:
    capabilities.json              current (overwritten each refresh)
    previous_capabilities.json     prior snapshot (kept before overwrite)
    capabilities.last_good.json    last successful scan (never destroyed on partial failure)
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .schema import CapabilityMap

HII_DIR = Path.home() / ".hii"
CURRENT_PATH = HII_DIR / "capabilities.json"
PREVIOUS_PATH = HII_DIR / "previous_capabilities.json"
LAST_GOOD_PATH = HII_DIR / "capabilities.last_good.json"

DEFAULT_TTL_SECONDS = 3600


def write(cap: CapabilityMap, *, mark_last_good: bool = True) -> dict[str, str]:
    """Atomically rotate previous → previous, current → previous, new → current.

    If `mark_last_good`, also writes capabilities.last_good.json.
    Returns the paths actually touched.
    """
    HII_DIR.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(cap.to_dict(), indent=2, default=str)

    touched: dict[str, str] = {}

    if CURRENT_PATH.exists():
        try:
            PREVIOUS_PATH.write_text(CURRENT_PATH.read_text(encoding="utf-8"), encoding="utf-8")
            touched["previous"] = str(PREVIOUS_PATH)
        except Exception:
            pass

    CURRENT_PATH.write_text(payload, encoding="utf-8")
    touched["current"] = str(CURRENT_PATH)

    if mark_last_good:
        LAST_GOOD_PATH.write_text(payload, encoding="utf-8")
        touched["last_good"] = str(LAST_GOOD_PATH)

    return touched


def read_current() -> dict[str, Any] | None:
    return _read(CURRENT_PATH)


def read_previous() -> dict[str, Any] | None:
    return _read(PREVIOUS_PATH)


def read_last_good() -> dict[str, Any] | None:
    return _read(LAST_GOOD_PATH)


def _read(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def is_fresh(ttl_seconds: int = DEFAULT_TTL_SECONDS) -> bool:
    """True if capabilities.json exists and is younger than ttl_seconds."""
    if not CURRENT_PATH.exists():
        return False
    age = time.time() - CURRENT_PATH.stat().st_mtime
    return age < ttl_seconds
