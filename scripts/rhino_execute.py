#!/usr/bin/env python3
"""Execute RhinoScript Python code in the active Rhino 8 session via RhinoMCP."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

AGENT_DIR = os.path.expanduser("~/dev/agent")
if AGENT_DIR not in sys.path:
    sys.path.insert(0, AGENT_DIR)

from rhino_mcp_smoketest import McpStdioClient, _mcp_initialize

DEFAULT_SERVER = os.environ.get("RHINO_MCP_SERVER", "uvx rhinomcp")


def _unwrap_success(result: dict) -> tuple[bool, str | None]:
    structured = result.get("structuredContent")
    if isinstance(structured, dict):
        payload = structured.get("result")
        if isinstance(payload, dict) and "success" in payload:
            ok = bool(payload.get("success"))
            message = payload.get("message")
            return ok, str(message) if message else None
    return not bool(result.get("isError")), None


def execute(code: str, server: str, timeout: float) -> dict:
    client = McpStdioClient(server.split())
    try:
        _mcp_initialize(client, timeout_s=timeout)
        result = client.request(
            "tools/call",
            params={"name": "execute_rhinoscript_python_code", "arguments": {"code": code}},
            timeout_s=timeout,
        )
        ok, message = _unwrap_success(result)
        return {
            "ok": ok,
            "server": server,
            "result": result,
            **({"message": message} if message else {}),
        }
    finally:
        client.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="Execute RhinoScript Python code via RhinoMCP")
    ap.add_argument("--code", default=None, help="RhinoScript Python source to execute")
    ap.add_argument("--file", default=None, help="Path to a RhinoScript Python file to execute")
    ap.add_argument("--server", default=DEFAULT_SERVER, help="RhinoMCP server command")
    ap.add_argument("--timeout", type=float, default=30.0, help="Timeout seconds")
    ns = ap.parse_args()

    code = ns.code
    if ns.file:
        code = Path(ns.file).read_text(encoding="utf-8")
    if not code:
        print(json.dumps({"error": "either --code or --file is required"}), file=sys.stderr)
        return 1

    try:
        result = execute(code, ns.server, ns.timeout)
        if not result.get("ok"):
            print(json.dumps(result, indent=2), file=sys.stderr)
            return 1
        print(json.dumps(result, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
