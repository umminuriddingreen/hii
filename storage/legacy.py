from __future__ import annotations

import json
from pathlib import Path

from hii.paths import HII_HOME

LEGACY_PATHS = {
    "settings": HII_HOME / "settings.json",
    "sessions": HII_HOME / "sessions.json",
    "conversations": HII_HOME / "conversations.json",
    "jobs": HII_HOME / "jobs.json",
    "memory": HII_HOME / "memory.json",
    "artifacts": HII_HOME / "artifacts.json",
}

def read_legacy_json(name: str):
    path = LEGACY_PATHS.get(name)
    if not path or not path.exists():
        return None
    return json.loads(path.read_text())
