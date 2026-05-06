"""Typed configuration with env var overrides."""

from __future__ import annotations
import json
from pathlib import Path
from dataclasses import dataclass, field, asdict

HII_DIR = Path.home() / ".hii"
CONFIG_FILE = HII_DIR / "config.json"
LEGACY_CONFIG = Path.cwd() / "agent.config.json"


@dataclass
class Config:
    # LLM
    chat_backend: str = "ollama"  # ollama | claude | lmstudio | mlx
    base_model: str = "qwen3.6:35b"
    coder_model: str = "qwen3.6:35b"
    embed_model: str = "nomic-embed-text"
    mlx_model: str = "mlx-community/AceReason-Nemotron-1.1-7B-4bit"

    # Paths
    db_path: str = str(HII_DIR / "data")
    workspace_path: str = str(HII_DIR / "workspace")
    sessions_path: str = str(HII_DIR / "sessions")
    memory_path: str = str(HII_DIR / "memory")
    notes_path: str = str(HII_DIR / "notes")

    # Memory
    memory_enabled: bool = True
    memory_max_entries: int = 30
    memory_max_tokens: int = 800

    # Token budget
    tool_result_max_chars: int = 2000
    skill_intercept: bool = True

    # Security
    allow_shell: bool = False
    allow_search: bool = False
    offline: bool = True

    # LM Studio
    lmstudio_url: str = "http://127.0.0.1:1234/v1"
    lmstudio_chat_model: str = "lmstudio-community/Meta-Llama-3-8B-Instruct"
    lmstudio_transcribe_model: str = "whisper-large-v3"

    # Ollama
    ollama_url: str = "http://127.0.0.1:11434"

    def save(self):
        HII_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_FILE.write_text(json.dumps(asdict(self), indent=2))

    @classmethod
    def load(cls) -> Config:
        """Load config: ~/.hii/config.json > agent.config.json > defaults."""
        data = {}

        # Try new location first
        if CONFIG_FILE.exists():
            data = json.loads(CONFIG_FILE.read_text())
        elif LEGACY_CONFIG.exists():
            raw = json.loads(LEGACY_CONFIG.read_text())
            # Map camelCase keys to snake_case
            key_map = {
                "chatBackend": "chat_backend", "baseModel": "base_model",
                "coderModel": "coder_model", "embedModel": "embed_model",
                "mlxModel": "mlx_model", "dbPath": "db_path",
                "workspacePath": "workspace_path", "sessionsPath": "sessions_path",
                "memoryPath": "memory_path", "memoryEnabled": "memory_enabled",
                "memoryMaxEntries": "memory_max_entries", "allowShell": "allow_shell",
                "allowSearch": "allow_search", "lmStudioUrl": "lmstudio_url",
                "lmStudioChatModel": "lmstudio_chat_model",
                "lmStudioTranscribeModel": "lmstudio_transcribe_model",
                "notesPath": "notes_path",
            }
            for old_key, new_key in key_map.items():
                if old_key in raw:
                    data[new_key] = raw[old_key]

        # Apply env var overrides
        import os
        env_map = {
            "HII_CHAT_BACKEND": "chat_backend",
            "HII_BASE_MODEL": "base_model",
            "HII_EMBED_MODEL": "embed_model",
            "OLLAMA_URL": "ollama_url",
            "LM_STUDIO_URL": "lmstudio_url",
        }
        for env_key, field_name in env_map.items():
            val = os.environ.get(env_key)
            if val:
                data[field_name] = val

        # Filter to valid fields only
        valid = {f.name for f in cls.__dataclass_fields__.values()}
        filtered = {k: v for k, v in data.items() if k in valid}
        return cls(**filtered)
