from __future__ import annotations

import json
from pathlib import Path


def codex_mcp_config(command: str = "hii") -> dict:
    return {
        "mcpServers": {
            "grasshopper": {
                "command": command,
                "args": ["harness", "grasshopper-mcp"],
                "env": {
                    "GRASSHOPPER_MCP_HOST": "127.0.0.1",
                    "GRASSHOPPER_MCP_PORT": "8080",
                    "GRASSHOPPER_MCP_TIMEOUT_S": "15",
                },
            }
        }
    }


def claude_desktop_config(command: str = "hii") -> dict:
    return {
        "mcpServers": {
            "grasshopper": {
                "command": command,
                "args": ["harness", "grasshopper-mcp"],
                "env": {
                    "GRASSHOPPER_MCP_HOST": "127.0.0.1",
                    "GRASSHOPPER_MCP_PORT": "8080",
                    "GRASSHOPPER_MCP_TIMEOUT_S": "15",
                },
            }
        }
    }


def write_json(path: str | Path, payload: dict) -> Path:
    target = Path(path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return target
